import { App, Plugin, PluginSettingTab, Setting, requestUrl, Notice, ItemView, WorkspaceLeaf } from 'obsidian';

const VIEW_TYPE_TASKS = "lightworx-tasks-view";

interface MyTasksSettings {
    apiUrl: string;
    clientId: string;
    clientSecret: string;
    defaultEmail: string; // New field
}

const DEFAULT_SETTINGS: MyTasksSettings = {
    apiUrl: 'https://tasks.lightworx.co.za',
    clientId: '',
    clientSecret: '',
    defaultEmail: ''
}

export default class MyTaskPlugin extends Plugin {
    settings: MyTasksSettings;
    accessToken: string | null = null;
    metaData: any = null; // Store statuses here

    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskView(leaf, this));
        this.addRibbonIcon('list-checks', 'Open Lightworx Tasks', () => this.activateView());
        this.addSettingTab(new MyTasksSettingTab(this.app, this));
    }

    async fetchMeta() {
        try {
            const response = await this.apiRequest('tasks/meta');
            this.metaData = response;
            return response;
        } catch (e) {
            console.error("Failed to fetch meta", e);
        }
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0] ?? workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: VIEW_TYPE_TASKS, active: true });
            workspace.revealLeaf(leaf);
        }
    }

    async getAccessToken(): Promise<string> {
        const response = await requestUrl({
            url: `${this.settings.apiUrl}/api/clients/token`,
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ client_id: this.settings.clientId, client_secret: this.settings.clientSecret })
        });
        return response.json.access_token;
    }

	async apiRequest(path: string, method: string = 'GET', body?: any) {
		if (!this.accessToken) this.accessToken = await this.getAccessToken();
		try {
			const response = await requestUrl({
				url: `${this.settings.apiUrl}/api/${path}`,
				method,
				headers: { 
					'Accept': 'application/json', 
					'Authorization': `Bearer ${this.accessToken}` 
				},
				contentType: 'application/json',
				body: body ? JSON.stringify(body) : undefined
			});

			// FIX: Only try to parse JSON if the response isn't empty
			// Status 204 means "No Content"
			if (response.status === 204 || !response.text) {
				return {}; 
			}

			return response.json;
		} catch (e) {
			if (e.status === 401) { 
				this.accessToken = null; 
				return this.apiRequest(path, method, body); 
			}
			throw e;
		}
	}

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }
}

class TaskView extends ItemView {
    plugin: MyTaskPlugin;
    showAdvanced: boolean = false;
    editingTaskId: string | null = null; // Track if we are editing

    // Persistent values for the form
    currentTitle: string = "";
    currentDesc: string = "";
    currentEmail: string = "";
    currentStatus: string = "";

    constructor(leaf: WorkspaceLeaf, plugin: MyTaskPlugin) { super(leaf); this.plugin = plugin; }
    getViewType() { return VIEW_TYPE_TASKS; }
    getDisplayText() { return "Lightworx Tasks"; }
    getIcon() { return "check-square"; }

    async onOpen() { await this.render(); }

    async render() {
        const container = this.containerEl.children[1];
        container.empty();
        
        // Ensure we actually wait for the data
        if (!this.plugin.metaData) {
            console.log("Fetching meta...");
            await this.plugin.fetchMeta();
        }

        // Double check: if it's still empty, try to fetch one more time or log it
        const statuses = this.plugin.metaData?.statuses || [];
        console.log("Statuses in render:", statuses);

        // --- FORM SECTION ---
        const formContainer = container.createDiv({ 
            style: "padding: 12px; background: var(--background-secondary); border-radius: 6px; margin: 10px; display: flex; flex-direction: column; gap: 10px;" 
        });
        
        // Title Field (Full Width)
        const titleIn = formContainer.createEl("input", { 
            type: "text", 
            placeholder: "Task title...", 
            style: "width: 100%; box-sizing: border-box;" 
        });
        titleIn.value = this.currentTitle;
        titleIn.oninput = () => { this.currentTitle = titleIn.value; };

        // Advanced Section (Hidden by default)
        if (this.showAdvanced) {
            // Description Field (Full Width)
            const descIn = formContainer.createEl("textarea", { 
                placeholder: "Description...", 
                style: "width: 100%; height: 80px; box-sizing: border-box; resize: none; font-size: 0.9em; margin-top: 5px;" 
            });
            descIn.value = this.currentDesc;
            descIn.oninput = () => { this.currentDesc = descIn.value; };

            // Email Field (Full Width)
            const emailIn = formContainer.createEl("input", { 
                type: "email", 
                placeholder: "Assigned Email...", 
                style: "width: 100%; box-sizing: border-box;" 
            });
            emailIn.value = this.currentEmail;
            emailIn.oninput = () => { this.currentEmail = emailIn.value; };
        }

        // Control Row (Select and Buttons)
        const controlRow = formContainer.createDiv({ 
            style: "display: flex; gap: 8px; align-items: center; justify-content: space-between;" 
        });

        // 1. If currentStatus is empty (first load), set it to the first available label
        if (!this.currentStatus && statuses.length > 0) {
            this.currentStatus = statuses[0].label;
        }

        const statusSel = controlRow.createEl("select", { style: "flex-grow: 1;" });

        statuses.forEach((status: any) => {
            const opt = statusSel.createEl("option", { 
                text: status.label, 
                value: status.label // Explicitly using label as the value
            });
            
            // Use case-insensitive comparison to be safe
            if (status.label === this.currentStatus) {
                opt.selected = true;
                opt.setAttribute("selected", "selected");
            }
        });

        statusSel.onchange = () => { 
            this.currentStatus = statusSel.value; 
        };

        const toggleBtn = controlRow.createEl("button", { 
            text: this.showAdvanced ? "Collapse" : "Expand", // Text is often clearer than symbols
            style: "font-size: 0.8em;"
        });
        toggleBtn.onclick = () => { 
            this.showAdvanced = !this.showAdvanced; 
            this.render(); 
        };

        const actionBtn = controlRow.createEl("button", { 
            text: this.editingTaskId ? "Save" : "Add", 
            cls: "mod-cta" 
        });
        
        // After saving, reset showAdvanced to false
        actionBtn.onclick = async () => {
            if (!this.currentTitle.trim()) {
                new Notice("Title is required");
                return;
            }

            const payload = {
                title: this.currentTitle,
                description: this.currentDesc,
                assigned_email: this.currentEmail || this.plugin.settings.defaultEmail,
                status: this.currentStatus // This will now send the Label
            };

            try {
                if (this.editingTaskId) {
                    await this.plugin.apiRequest(`tasks/${this.editingTaskId}`, 'PUT', payload);
                    new Notice("Task updated");
                } else {
                    await this.plugin.apiRequest('tasks', 'POST', payload);
                    new Notice("Task added");
                }

                // Reset form
                this.editingTaskId = null;
                this.currentTitle = "";
                this.currentDesc = "";
                this.currentEmail = this.plugin.settings.defaultEmail;
                this.showAdvanced = false;
                
                await this.render();
            } catch (e) {
                new Notice("Failed to save task");
                console.error(e);
            }
        };

        if (this.editingTaskId) {
            const cancelBtn = controlRow.createEl("button", { text: "Cancel", style: "height: 32px;" });
            cancelBtn.onclick = () => {
                this.editingTaskId = null;
                this.currentTitle = ""; this.currentDesc = ""; this.currentEmail = "";
                this.render();
            };
        }

        container.createEl("hr", { style: "margin: 5px 10px;" });

        // --- LIST SECTION ---
        try {
            const res = await this.plugin.apiRequest('tasks');
            const tasks = res.data || [];
            const listContainer = container.createDiv({ style: "padding: 0 10px;" });

            tasks.forEach((task: any) => {
                // Find the color from our meta data
                const statusInfo = statuses.find((s: any) => s.label === task.status);
                const statusColor = statusInfo?.colour || 'var(--text-muted)';

                const taskItem = new Setting(listContainer)
                    .setName(task.title)
                    .addExtraButton(btn => {
                        btn.setIcon("pencil").onClick(() => {
                            this.editingTaskId = task.id;
                            this.currentTitle = task.title;
                            this.currentDesc = task.description || "";
                            this.currentEmail = task.assigned_email || "";
                            this.currentStatus = task.status;
                            this.showAdvanced = !!task.description;
                            this.render();
                        });
                    })
                    // ... (trash button) ...

                // Compact layout
                taskItem.settingEl.style.padding = "2px 0";
                taskItem.settingEl.style.border = "none";
                taskItem.settingEl.style.minHeight = "auto"; 
                
                const nameEl = taskItem.nameEl;
                nameEl.style.fontSize = "0.85em";
                nameEl.style.display = "flex";
                nameEl.style.alignItems = "center";
                nameEl.style.gap = "8px";

                // DYNAMIC COLOR DOT
                const dot = document.createElement("div");
                Object.assign(dot.style, {
                    width: "7px", height: "7px", borderRadius: "50%",
                    backgroundColor: statusColor, flexShrink: "0"
                });
                nameEl.prepend(dot);

                // Check for 'completed' logic (you might want to add an 'is_completed' 
                // boolean to your migration later, but for now we check the id)
                if (task.status === 'completed') {
                    nameEl.style.textDecoration = "line-through";
                    nameEl.style.color = "var(--text-muted)";
                }
            });
        } catch (e) {
            container.createEl("p", { text: "Error loading tasks." });
        }
    }

    async fetchMeta() {
        this.metaData = await this.apiRequest('tasks/meta');
    }
}

class MyTasksSettingTab extends PluginSettingTab {
    plugin: MyTaskPlugin;
    constructor(app: App, plugin: MyTaskPlugin) { super(app, plugin); this.plugin = plugin; }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'API Settings' });

        new Setting(containerEl).setName('API URL').addText(t => t.setValue(this.plugin.settings.apiUrl).onChange(async v => { this.plugin.settings.apiUrl = v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Client ID').addText(t => t.setValue(this.plugin.settings.clientId).onChange(async v => { this.plugin.settings.clientId = v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Client Secret').addText(t => t.setValue(this.plugin.settings.clientSecret).onChange(async v => { this.plugin.settings.clientSecret = v; await this.plugin.saveSettings(); }));
        
        new Setting(containerEl)
            .setName('Default Assigned Email')
            .setDesc('Auto-fills this email in the task creator')
            .addText(t => t.setValue(this.plugin.settings.defaultEmail).onChange(async v => { 
                this.plugin.settings.defaultEmail = v; 
                await this.plugin.saveSettings(); 
            }));
    }
}