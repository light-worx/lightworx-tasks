import { App, Plugin, PluginSettingTab, Setting, requestUrl, Notice, ItemView, WorkspaceLeaf } from 'obsidian';

const VIEW_TYPE_TASKS = "lightworx-tasks-view";

interface MyTasksSettings {
    apiUrl: string;
    clientId: string;
    clientSecret: string;
    defaultEmail: string;
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
    metaData: any = null;

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
    editingTaskId: string | null = null;
    searchQuery: string = "";
    filterStatus: string = "all";

    currentTitle: string = "";
    currentDesc: string = "";
    currentEmail: string = "";
    currentStatus: string = "";

    // Stable references to the task list container and the cached API data,
    // so search/filter can redraw just that region without touching the form.
    private taskListEl: HTMLElement | null = null;
    private cachedTasks: any[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: MyTaskPlugin) { super(leaf); this.plugin = plugin; }
    getViewType() { return VIEW_TYPE_TASKS; }
    getDisplayText() { return "Lightworx Tasks"; }
    getIcon() { return "check-square"; }

    async onOpen() { await this.render(); }

    async render() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        this.taskListEl = null;

        if (!this.plugin.metaData) {
            await this.plugin.fetchMeta();
        }

        const statuses = this.plugin.metaData?.statuses || [];

        const wrapper = container.createDiv({
            attr: { style: "padding: 10px; display: flex; flex-direction: column; gap: 8px;" }
        });

        const inputStyle = "width: 100%; height: 30px; font-size: var(--font-ui-small); box-sizing: border-box;";

        // ── SECTION LABEL ─────────────────────────────────────────────────────
        const formLabel = wrapper.createEl("p");
        formLabel.style.cssText = [
            "margin: 0",
            "font-size: var(--font-ui-smaller)",
            "font-weight: 600",
            "letter-spacing: 0.05em",
            "text-transform: uppercase",
            "color: var(--text-muted)",
        ].join("; ");
        formLabel.setText(this.editingTaskId ? "Edit task" : "New task");

        // ── FORM ──────────────────────────────────────────────────────────────
        const formContainer = wrapper.createDiv();
        formContainer.style.cssText = [
            "background: var(--background-secondary)",
            "border-radius: var(--radius-m)",
            "padding: 10px",
            "display: flex",
            "flex-direction: column",
            "gap: 6px",
            "box-shadow: var(--shadow-s)",
        ].join("; ");

        // Title
        const titleIn = formContainer.createEl("input", { type: "text", placeholder: "Task title..." });
        titleIn.style.cssText = inputStyle;
        titleIn.value = this.currentTitle;
        titleIn.oninput = () => { this.currentTitle = titleIn.value; };

        // Advanced fields
        if (this.showAdvanced) {
            const descIn = formContainer.createEl("textarea", { placeholder: "Description..." });
            descIn.style.cssText = "width: 100%; height: 80px; font-size: var(--font-ui-small); box-sizing: border-box; resize: none;";
            descIn.value = this.currentDesc;
            descIn.oninput = () => { this.currentDesc = descIn.value; };

            const emailIn = formContainer.createEl("input", { type: "email", placeholder: "Assigned email..." });
            emailIn.style.cssText = inputStyle;
            emailIn.value = this.currentEmail;
            emailIn.oninput = () => { this.currentEmail = emailIn.value; };
        }

        // Control row: status | more/less | [cancel] | add/save
        const controlRow = formContainer.createDiv();
        controlRow.style.cssText = "display: flex; gap: 6px; align-items: center;";

        if (!this.currentStatus && statuses.length > 0) {
            this.currentStatus = statuses[0].label;
        }

        const statusSel = controlRow.createEl("select");
        statusSel.style.cssText = "flex: 1; height: 30px; font-size: var(--font-ui-small);";
        statuses.forEach((status: any) => {
            const opt = statusSel.createEl("option", { text: status.label, value: status.label });
            if (status.label === this.currentStatus) opt.selected = true;
        });
        statusSel.onchange = () => { this.currentStatus = statusSel.value; };

        const toggleBtn = controlRow.createEl("button", { text: this.showAdvanced ? "Less" : "More" });
        toggleBtn.style.cssText = "height: 30px; font-size: var(--font-ui-small); color: var(--text-muted); background: var(--background-modifier-border); border: none; border-radius: var(--radius-s); cursor: pointer; padding: 0 8px;";
        toggleBtn.onclick = () => { this.showAdvanced = !this.showAdvanced; this.render(); };

        if (this.editingTaskId) {
            const cancelBtn = controlRow.createEl("button", { text: "Cancel" });
            cancelBtn.style.cssText = "height: 30px; font-size: var(--font-ui-small); padding: 0 8px;";
            cancelBtn.onclick = () => {
                this.editingTaskId = null;
                this.currentTitle = ""; this.currentDesc = ""; this.currentEmail = "";
                this.render();
            };
        }

        const actionBtn = controlRow.createEl("button", {
            text: this.editingTaskId ? "Save" : "Add",
            cls: "mod-cta"
        });
        actionBtn.style.cssText = "height: 30px; font-size: var(--font-ui-small); padding: 0 12px;";
        actionBtn.onclick = async () => {
            if (!this.currentTitle.trim()) {
                new Notice("Title is required");
                return;
            }

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

        // ── TASK LIST HEADER (label + search + filter, visually grouped) ──────
        const listHeader = wrapper.createDiv();
        listHeader.style.cssText = "display: flex; align-items: center; gap: 6px; margin-top: 4px;";

        const listLabel = listHeader.createEl("span");
        listLabel.style.cssText = [
            "font-size: var(--font-ui-smaller)",
            "font-weight: 600",
            "letter-spacing: 0.05em",
            "text-transform: uppercase",
            "color: var(--text-muted)",
            "flex-shrink: 0",
        ].join("; ");
        listLabel.setText("Tasks");

        const ruleFlex = listHeader.createEl("span");
        ruleFlex.style.cssText = "flex: 1; height: 1px; background: var(--background-modifier-border);";

        const searchIn = listHeader.createEl("input", { type: "text", placeholder: "Search…" });
        searchIn.style.cssText = "width: 110px; height: 26px; font-size: var(--font-ui-small); box-sizing: border-box;";
        searchIn.value = this.searchQuery;
        searchIn.oninput = () => {
            // Update state and redraw only the list — search input keeps focus.
            this.searchQuery = searchIn.value.toLowerCase();
            this.renderTaskList(statuses);
        };

        const filterSel = listHeader.createEl("select");
        filterSel.style.cssText = "height: 26px; font-size: var(--font-ui-small); max-width: 100px;";
        filterSel.createEl("option", { text: "All", value: "all" });
        statuses.forEach((s: any) => {
            const opt = filterSel.createEl("option", { text: s.label, value: s.label });
            if (this.filterStatus === s.label) opt.selected = true;
        });
        filterSel.onchange = () => {
            this.filterStatus = filterSel.value;
            this.renderTaskList(statuses);
        };

        // ── TASK LIST CONTAINER ───────────────────────────────────────────────
        // A stable div that renderTaskList() will empty+refill in place.
        this.taskListEl = wrapper.createDiv();

        // Fetch once and cache, then hand off to renderTaskList.
        try {
            const res = await this.plugin.apiRequest('tasks');
            this.cachedTasks = res.data || [];
        } catch (e) {
            this.cachedTasks = [];
            this.taskListEl.createEl("p", { text: "Error loading tasks." });
            return;
        }

        this.renderTaskList(statuses);
    }

    // Redraws only the task list area using cachedTasks. Safe to call without
    // losing focus on the search input because the form DOM is untouched.
    private renderTaskList(statuses: any[]) {
        if (!this.taskListEl) return;
        this.taskListEl.empty();

        let tasks = [...this.cachedTasks];

        if (this.filterStatus !== "all") {
            tasks = tasks.filter((t: any) => t.status === this.filterStatus);
        }
        if (this.searchQuery) {
            tasks = tasks.filter((t: any) =>
                t.title.toLowerCase().includes(this.searchQuery) ||
                (t.description && t.description.toLowerCase().includes(this.searchQuery))
            );
        }

        if (tasks.length === 0) {
            const empty = this.taskListEl.createEl("p", { text: "No tasks match your filters." });
            empty.style.cssText = "text-align: center; color: var(--text-muted); font-size: var(--font-ui-small); margin: 16px 0;";
            return;
        }

        tasks.forEach((task: any) => {
            const statusInfo = statuses.find((s: any) => s.label === task.status);
            const statusColor = statusInfo?.colour || 'var(--text-muted)';
            const isCompleted = task.status?.toLowerCase() === 'completed';

            const editAction = () => {
                this.editingTaskId = task.id;
                this.currentTitle = task.title;
                this.currentDesc = task.description || "";
                this.currentEmail = task.assigned_email || "";
                this.currentStatus = task.status;
                this.showAdvanced = !!task.description;
                this.render();
            };

            const taskItem = new Setting(this.taskListEl!)
                .setName(task.title)
                .addExtraButton(btn => {
                    btn.setIcon("trash")
                        .setTooltip("Delete")
                        .onClick(async () => {
                            if (confirm("Delete task?")) {
                                await this.plugin.apiRequest(`tasks/${task.id}`, 'DELETE');
                                this.render();
                            }
                        });
                });

            taskItem.settingEl.style.cssText = "padding: 3px 0; border: none; min-height: auto;";

            if (isCompleted) {
                taskItem.settingEl.style.opacity = "0.5";
            }

            const nameEl = taskItem.nameEl;
            nameEl.style.cssText = [
                "font-size: var(--font-ui-small)",
                "display: flex",
                "align-items: center",
                "gap: 8px",
                "cursor: pointer",
            ].join("; ");
            nameEl.title = "Edit task";
            nameEl.onclick = editAction;

            if (isCompleted) {
                nameEl.style.textDecoration = "line-through";
                nameEl.style.color = "var(--text-muted)";
            }

            const dot = document.createElement("div");
            dot.style.cssText = `width: 7px; height: 7px; border-radius: 50%; background-color: ${statusColor}; flex-shrink: 0;`;
            dot.title = task.status ?? "";
            nameEl.prepend(dot);
        });
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