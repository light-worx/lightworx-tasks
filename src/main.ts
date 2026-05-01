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
    currentStatus: string = "active";

    constructor(leaf: WorkspaceLeaf, plugin: MyTaskPlugin) { super(leaf); this.plugin = plugin; }
    getViewType() { return VIEW_TYPE_TASKS; }
    getDisplayText() { return "Lightworx Tasks"; }
    getIcon() { return "check-square"; }

    async onOpen() { await this.render(); }

    getStatusColor(status: string) {
        switch (status) {
            case 'active': return '#2ecc71';
            case 'waiting': return '#f1c40f';
            case 'clarify': return '#e67e22';
            case 'completed': return '#3498db';
            default: return 'var(--text-muted)';
        }
    }

    async render() {
        const container = this.containerEl.children[1];
        container.empty();

        if (!this.plugin.metaData) {
            await this.plugin.fetchMeta();
        }

        // Capture the data inside the 'statuses' key
        // We use a fallback to empty array if the key doesn't exist
        let statusData = this.plugin.metaData?.statuses || [];

        // Force it to be an array even if the API returned a single object
        if (!Array.isArray(statusData)) {
            // If it's an object (like { "active": {...} }), convert values to array
            if (typeof statusData === 'object' && statusData !== null) {
                statusData = Object.values(statusData);
            } else {
                statusData = [];
            }
        }

        const statuses: any[] = statusData;

        if (statuses.length === 0) {
            console.warn("Lightworx: Statuses list is empty. Check API response structure.");
        }
        
        // --- FORM SECTION ---
        const formContainer = container.createDiv({ 
            style: "padding: 12px; background: var(--background-secondary); border-radius: 6px; margin: 10px; display: flex; flex-direction: column; gap: 10px; align-items: flex-end;" 
        });
        
        // Row 1: Title
        const titleRow = formContainer.createDiv({ style: "width: 100%;" });
        const titleIn = titleRow.createEl("input", { 
            type: "text", placeholder: "Task title...", 
            style: "width: 100% !important; min-width: 100% !important; box-sizing: border-box;" 
        });
        titleIn.value = this.currentTitle;
        titleIn.oninput = () => { this.currentTitle = titleIn.value; };

        // Advanced Section
        if (this.showAdvanced) {
            const advRow = formContainer.createDiv({ style: "width: 100%; display: flex; flex-direction: column; gap: 8px;" });
            const descIn = advRow.createEl("textarea", { 
                placeholder: "Description...", 
                style: "width: 100% !important; min-width: 100% !important; height: 60px; font-size: 0.8em; box-sizing: border-box; resize: none;" 
            });
            descIn.value = this.currentDesc;
            descIn.oninput = () => { this.currentDesc = descIn.value; };

            const emailIn = advRow.createEl("input", { 
                type: "email", placeholder: "Assigned Email...", 
                style: "width: 100% !important; min-width: 100% !important; box-sizing: border-box;" 
            });
            emailIn.value = this.currentEmail || this.plugin.settings.defaultEmail;
            emailIn.oninput = () => { this.currentEmail = emailIn.value; };
        }

        // Row 2: Control Row
        const controlRow = formContainer.createDiv({ 
            style: "display: flex; gap: 6px; align-items: center; width: 100%; justify-content: flex-end;" 
        });
        
        const statusSel = controlRow.createEl("select", { style: "flex-grow: 1; height: 32px;" });
    
        statuses.forEach((status: any) => {
            const opt = statusSel.createEl("option", { 
                text: status.label || status.id, 
                value: status.id 
            });
            if (status.id === this.currentStatus) opt.selected = true;
        });

        statusSel.onchange = () => {
            this.currentStatus = statusSel.value;
            // Optional: new Notice(`Status changed to ${this.currentStatus}`);
        };
        
        // If currentStatus is empty/default, set it to the first available status id
        if (!this.currentStatus && statuses.length > 0) {
            this.currentStatus = statuses[0].id;
        }

        const toggleBtn = controlRow.createEl("button", { 
            text: this.showAdvanced ? "–" : "+", style: "width: 35px; height: 32px;" 
        });
        toggleBtn.onclick = () => { 
            this.showAdvanced = !this.showAdvanced; 
            this.render(); 
        };

        const actionBtn = controlRow.createEl("button", { 
            text: this.editingTaskId ? "Save" : "Add", 
            cls: "mod-cta", style: "height: 32px; padding: 0 15px;" 
        });

        actionBtn.onclick = async () => {
            if (!this.currentTitle) return;
            const payload = { 
                title: this.currentTitle, 
                description: this.currentDesc, 
                assigned_email: this.currentEmail || this.plugin.settings.defaultEmail, 
                status: this.currentStatus 
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
                this.currentTitle = ""; this.currentDesc = ""; this.currentEmail = ""; this.currentStatus = "active";
                this.render();
            } catch (e) {
                new Notice("Error saving task.");
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
                const statusInfo = statuses.find((s: any) => s.id === task.status);
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
                            this.showAdvanced = true;
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