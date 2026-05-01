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

    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskView(leaf, this));
        this.addRibbonIcon('list-checks', 'Open Lightworx Tasks', () => this.activateView());
        this.addSettingTab(new MyTasksSettingTab(this.app, this));
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
    showAdvanced: boolean = false; // Toggle state

    currentDescEl: HTMLTextAreaElement | null = null;
    currentEmailEl: HTMLInputElement | null = null;

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
		
		// --- FORM SECTION ---
		// Added align-items: flex-end to push smaller items to the right
		const formContainer = container.createDiv({ 
			style: "padding: 12px; background: var(--background-secondary); border-radius: 6px; margin: 10px; display: flex; flex-direction: column; gap: 10px; align-items: flex-end;" 
		});
		
		// Row 1: Title
		const titleRow = formContainer.createDiv({ style: "width: 100%;" });
		const titleIn = titleRow.createEl("input", { 
			type: "text", 
			placeholder: "Task title...", 
			style: "width: 100% !important; min-width: 100% !important; box-sizing: border-box;" 
		});

		// Advanced Section
		if (this.showAdvanced) {
			const advRow = formContainer.createDiv({ style: "width: 100%; display: flex; flex-direction: column; gap: 8px;" });
			this.currentDescEl = advRow.createEl("textarea", { 
				placeholder: "Description...", 
				style: "width: 100% !important; min-width: 100% !important; height: 60px; font-size: 0.8em; box-sizing: border-box; resize: none;" 
			});
			this.currentEmailEl = advRow.createEl("input", { 
				type: "email", 
				placeholder: "Assigned Email...", 
				style: "width: 100% !important; min-width: 100% !important; box-sizing: border-box;" 
			});
			this.currentEmailEl.value = this.plugin.settings.defaultEmail;
		}

		// Row 2: Control Row
		// justify-content: flex-end ensures that if they don't fill the width, they sit on the right
		const controlRow = formContainer.createDiv({ 
			style: "display: flex; gap: 6px; align-items: center; width: 100%; justify-content: flex-end;" 
		});
		
		const statusSel = controlRow.createEl("select", { 
			style: "flex-grow: 1; height: 32px; min-width: 0; box-sizing: border-box;" 
		});
		['active', 'waiting', 'clarify', 'completed'].forEach(s => {
			statusSel.createEl("option", { text: s, value: s });
		});

		const toggleBtn = controlRow.createEl("button", { 
			text: this.showAdvanced ? "–" : "+", 
			style: "width: 35px; height: 32px; flex-shrink: 0;" 
		});
		toggleBtn.onclick = () => { this.showAdvanced = !this.showAdvanced; this.render(); };

		const addBtn = controlRow.createEl("button", { 
			text: "Add", 
			cls: "mod-cta", 
			style: "height: 32px; padding: 0 20px; flex-shrink: 0;" 
		});

		addBtn.onclick = async () => {
			if (!titleIn.value) return;
			try {
				await this.plugin.apiRequest('tasks', 'POST', { 
					title: titleIn.value,
					description: this.showAdvanced ? this.currentDescEl?.value : "",
					assigned_email: this.showAdvanced ? this.currentEmailEl?.value : this.plugin.settings.defaultEmail,
					status: statusSel.value
				});
				titleIn.value = "";
				this.render();
			} catch (e) {
				new Notice("Error saving task.");
			}
		};

		container.createEl("hr", { style: "margin: 5px 10px;" });

		// --- LIST SECTION (Remains the same as previous) ---
		try {
			const res = await this.plugin.apiRequest('tasks');
			const tasks = res.data || [];
			const listContainer = container.createDiv({ style: "padding: 0 10px;" });

			tasks.forEach((task: any) => {
				const taskItem = new Setting(listContainer)
					.setName(task.title)
					.addExtraButton(btn => {
						btn.setIcon("trash").onClick(async () => {
							if(confirm("Delete task?")) {
								await this.plugin.apiRequest(`tasks/${task.id}`, 'DELETE');
								this.render();
							}
						});
					});

				taskItem.settingEl.style.padding = "2px 0";
				taskItem.settingEl.style.border = "none";
				taskItem.settingEl.style.minHeight = "auto"; 
				
				const nameEl = taskItem.nameEl;
				nameEl.style.fontSize = "0.85em";
				nameEl.style.display = "flex";
				nameEl.style.alignItems = "center";
				nameEl.style.gap = "8px";

				const dot = document.createElement("div");
				Object.assign(dot.style, {
					width: "7px", height: "7px", borderRadius: "50%",
					backgroundColor: this.getStatusColor(task.status), flexShrink: "0"
				});
				nameEl.prepend(dot);

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