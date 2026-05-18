import { App, Plugin, PluginSettingTab, Setting, requestUrl, Notice, ItemView, WorkspaceLeaf } from 'obsidian';

const VIEW_TYPE_TASKS = "lightworx-tasks-view";

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

interface MyTasksSettings {
    apiUrl: string;
    clientId: string;
    clientSecret: string;
    userEmail: string;
    scheduleToCalendar: boolean;   // create a calendar event when a task has due_at
    calendarId: string;            // target calendar (overrides calendar plugin default)
    defaultTaskDuration: number;   // minutes; used when creating a calendar event
}

const DEFAULT_SETTINGS: MyTasksSettings = {
    apiUrl: 'https://tasks.lightworx.co.za',
    clientId: '',
    clientSecret: '',
    userEmail: '',
    scheduleToCalendar: false,
    calendarId: '',
    defaultTaskDuration: 30,
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

export default class MyTaskPlugin extends Plugin {
    settings: MyTasksSettings;
    accessToken: string | null = null;
    metaData: any = null;
    projects: any[] = [];

    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskView(leaf, this));
        this.addRibbonIcon('list-checks', 'Open Lightworx Tasks', () => this.activateView());
        this.addSettingTab(new MyTasksSettingTab(this.app, this));
    }

    calPlugin(): any | null {
        const p = (this.app as any).plugins?.plugins?.['lightworx-calendar'];
        return p ?? null;
    }

    async fetchMeta() {
        try {
            const response = await this.apiRequest('meta/task-statuses');
            this.metaData = { statuses: response.statuses ?? response };
        } catch (e) {
            console.error("Failed to fetch meta", e);
        }
    }

    async fetchProjects() {
        try {
            const email = this.settings.userEmail;
            const qs = email ? `?owner_email=${encodeURIComponent(email)}` : '';
            const response = await this.apiRequest(`projects${qs}`);
            this.projects = Array.isArray(response) ? response : (response.data ?? []);
        } catch (e) {
            console.error("Failed to fetch projects", e);
            this.projects = [];
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
            url: `${this.settings.apiUrl}/api/auth/token`,
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ client_id: this.settings.clientId, client_secret: this.settings.clientSecret })
        });
        return response.json.access_token;
    }

    async apiRequest(path: string, method: string = 'GET', body?: any): Promise<any> {
        if (!this.accessToken) this.accessToken = await this.getAccessToken();
        try {
            const response = await requestUrl({
                url: `${this.settings.apiUrl}/api/${path}`,
                method,
                headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${this.accessToken}` },
                contentType: 'application/json',
                body: body ? JSON.stringify(body) : undefined,
                throw: false,  // Don't throw on non-2xx — handle it ourselves
            });
            if (response.status === 401) {
                this.accessToken = null;
                return this.apiRequest(path, method, body);
            }
            if (response.status >= 400) {
                // Log the actual API error body so we can see the real message
                let errorBody: any = response.text;
                try { errorBody = JSON.parse(response.text); } catch {}
                console.error(`Tasks API error [${method} ${path}]`, {
                    status: response.status,
                    body: errorBody,
                });
                const err: any = new Error(`Request failed, status ${response.status}`);
                err.status = response.status;
                err.body = errorBody;
                throw err;
            }
            if (response.status === 204 || !response.text) return {};
            return response.json;
        } catch (e) {
            if ((e as any).status) throw e;  // Already handled above
            throw e;
        }
    }

    async loadSettings() {
        const data = await this.loadData() ?? {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        this.cachedTasksStore = data.cachedTasks ?? [];
    }

    async saveSettings() {
        await this.saveData({
            ...this.settings,
            cachedTasks: this.cachedTasksStore,
        });
    }

    // Persisted task cache — survives plugin restarts
    cachedTasksStore: any[] = [];

    async persistTaskCache(tasks: any[]) {
        this.cachedTasksStore = tasks;
        await this.saveSettings();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared style helpers
// ─────────────────────────────────────────────────────────────────────────────

const S = {
    input:   "width: 100%; height: 30px; font-size: var(--font-ui-small); box-sizing: border-box;",
    btnMuted: [
        "height: 26px",
        "font-size: var(--font-ui-small)",
        "color: var(--text-muted)",
        "background: var(--background-modifier-border)",
        "border: none",
        "border-radius: var(--radius-s)",
        "cursor: pointer",
        "padding: 0 8px",
    ].join("; "),
};

// ─────────────────────────────────────────────────────────────────────────────
// Root view — renders tab bar and delegates to panes
// ─────────────────────────────────────────────────────────────────────────────

type Tab = 'tasks' | 'projects';

class TaskView extends ItemView {
    plugin: MyTaskPlugin;
    private activeTab: Tab = 'tasks';
    private tasksPane: TasksPane;
    private projectsPane: ProjectsPane;

    constructor(leaf: WorkspaceLeaf, plugin: MyTaskPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.tasksPane    = new TasksPane(plugin);
        this.projectsPane = new ProjectsPane(plugin);
    }

    getViewType()    { return VIEW_TYPE_TASKS; }
    getDisplayText() { return "Lightworx Tasks"; }
    getIcon()        { return "check-square"; }

    async onOpen() { await this.render(); }

    async render() {
        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.style.cssText = "display: flex; flex-direction: column; height: 100%; overflow: hidden;";

        // ── TAB BAR ───────────────────────────────────────────────────────────
        const tabBar = root.createDiv();
        tabBar.style.cssText = [
            "display: flex",
            "border-bottom: 1px solid var(--background-modifier-border)",
            "flex-shrink: 0",
        ].join("; ");

        const tabStyle = (active: boolean) => [
            "flex: 1",
            "padding: 8px 0",
            "font-size: var(--font-ui-small)",
            "font-weight: 500",
            "text-align: center",
            "cursor: pointer",
            "border: none",
            "border-bottom: 2px solid " + (active ? "var(--interactive-accent)" : "transparent"),
            "background: transparent",
            "color: " + (active ? "var(--text-normal)" : "var(--text-muted)"),
            "transition: color 0.15s, border-color 0.15s",
        ].join("; ");

        const tasksTab    = tabBar.createEl("button", { text: "Tasks" });
        const projectsTab = tabBar.createEl("button", { text: "Projects" });
        tasksTab.style.cssText    = tabStyle(this.activeTab === 'tasks');
        projectsTab.style.cssText = tabStyle(this.activeTab === 'projects');

        // ── PANE CONTAINER ────────────────────────────────────────────────────
        const paneEl = root.createDiv();
        paneEl.style.cssText = "flex: 1; overflow-y: auto;";

        const switchTab = async (tab: Tab) => {
            this.activeTab = tab;
            tasksTab.style.cssText    = tabStyle(tab === 'tasks');
            projectsTab.style.cssText = tabStyle(tab === 'projects');
            paneEl.empty();
            if (tab === 'tasks')    await this.tasksPane.mount(paneEl);
            if (tab === 'projects') await this.projectsPane.mount(paneEl);
        };

        tasksTab.onclick    = () => switchTab('tasks');
        projectsTab.onclick = () => switchTab('projects');

        // Mount the active pane immediately
        await switchTab(this.activeTab);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks pane
// ─────────────────────────────────────────────────────────────────────────────

class TasksPane {
    private plugin: MyTaskPlugin;

    // Form state
    private showForm: boolean = false;
    private editingTaskId: string | null = null;
    private currentTitle: string = "";
    private currentDesc: string = "";
    private currentStatus: string = "";
    private currentProjectId: string = "";

    // List state
    private searchQuery: string = "";
    private filterStatus: string = "all";
    private cachedTasks: any[] = [];
    private taskListEl: HTMLElement | null = null;
    private mountContainer: HTMLElement | null = null;
    private formJustOpened: boolean = false;

    // Cached for re-renders
    private statuses: any[] = [];
    private projects: any[] = [];

    constructor(plugin: MyTaskPlugin) {
        this.plugin = plugin;
    }

    async mount(container: HTMLElement) {
        this.mountContainer = container;
        container.empty();
        this.taskListEl = null;

        const metaPromise     = this.plugin.metaData ? Promise.resolve() : this.plugin.fetchMeta();
        const projectsPromise = this.plugin.fetchProjects();
        await Promise.all([metaPromise, projectsPromise]);

        this.statuses = this.plugin.metaData?.statuses || [];
        this.projects = this.plugin.projects || [];

        if (!this.currentStatus && this.statuses.length > 0) {
            this.currentStatus = this.statuses[0].label;
        }

        const wrapper = container.createDiv({
            attr: { style: "padding: 10px; display: flex; flex-direction: column; gap: 8px;" }
        });

        // ── TOOLBAR: search | filter | + ──────────────────────────────────────
        const toolbar = wrapper.createDiv();
        toolbar.style.cssText = "display: flex; align-items: center; gap: 6px;";

        const searchIn = toolbar.createEl("input", { type: "text", placeholder: "Search…" });
        searchIn.style.cssText = "flex: 1; height: 26px; font-size: var(--font-ui-small); box-sizing: border-box;";
        searchIn.value = this.searchQuery;
        searchIn.oninput = () => {
            this.searchQuery = searchIn.value.toLowerCase();
            this.renderTaskList();
        };

        const filterSel = toolbar.createEl("select");
        filterSel.style.cssText = "height: 26px; font-size: var(--font-ui-small); max-width: 90px;";
        filterSel.createEl("option", { text: "All", value: "all" });
        this.statuses.forEach((s: any) => {
            const opt = filterSel.createEl("option", { text: s.label, value: s.label });
            if (this.filterStatus === s.label) opt.selected = true;
        });
        filterSel.onchange = () => {
            this.filterStatus = filterSel.value;
            this.renderTaskList();
        };

        const addBtn = toolbar.createEl("button", { text: "+" });
        addBtn.style.cssText = [
            "height: 26px",
            "width: 26px",
            "font-size: 16px",
            "line-height: 1",
            "padding: 0",
            "border: none",
            "border-radius: var(--radius-s)",
            "background: var(--interactive-accent)",
            "color: var(--text-on-accent)",
            "cursor: pointer",
            "flex-shrink: 0",
        ].join("; ");
        addBtn.title = "New task";
        addBtn.onclick = () => {
            // Toggle form; if opening fresh (not editing), clear state
            if (!this.showForm || this.editingTaskId) {
                this.editingTaskId = null;
                this.currentTitle = "";
                this.currentDesc = "";
                this.currentProjectId = "";
                this.currentStatus = this.statuses[0]?.label ?? "";
            }
            this.formJustOpened = !this.showForm; // true only when opening, not closing
            this.showForm = !this.showForm;
            this.mount(container);
        };

        // ── FORM (shown only when showForm is true) ───────────────────────────
        if (this.showForm) {
            this.renderForm(wrapper, container);
        }

        // ── TASK LIST ─────────────────────────────────────────────────────────
        this.taskListEl = wrapper.createDiv();

        // ── STALE-WHILE-REVALIDATE ────────────────────────────────────────────
        // 1. Render persisted cache immediately so the list appears with no delay.
        const persisted = this.plugin.cachedTasksStore;
        if (persisted.length > 0) {
            this.cachedTasks = persisted;
            this.renderTaskList();
            // Show a subtle "refreshing" indicator in the toolbar
            const refreshDot = toolbar.createEl("span");
            refreshDot.title = "Refreshing…";
            refreshDot.style.cssText = [
                "width: 6px",
                "height: 6px",
                "border-radius: 50%",
                "background: var(--text-muted)",
                "flex-shrink: 0",
                "opacity: 0.5",
                "align-self: center",
            ].join("; ");

            // 2. Fetch fresh data in the background — but skip if the form is
            //    open, since re-rendering the task list while the user is typing
            //    causes focus loss.
            if (!this.showForm) {
                try {
                    const email  = this.plugin.settings.userEmail;
                    const params = email
                        ? `?assigned_email=${encodeURIComponent(email)}&owner_email=${encodeURIComponent(email)}`
                        : '';
                    const res   = await this.plugin.apiRequest(`tasks${params}`);
                    const fresh = res.data || [];

                    // 3. Only re-render if data actually changed.
                    if (JSON.stringify(fresh) !== JSON.stringify(this.cachedTasks)) {
                        this.cachedTasks = fresh;
                        this.renderTaskList();
                    }
                    await this.plugin.persistTaskCache(fresh);
                    refreshDot.remove();
                } catch (e) {
                    // Network failed — cached data stays visible, dot turns amber.
                    refreshDot.style.background = "var(--color-orange)";
                    refreshDot.style.opacity = "1";
                    refreshDot.title = "Could not refresh — showing cached data";
                }
            } else {
                refreshDot.remove();
            }
        } else {
            // No cache yet — show a loading state and wait for the network.
            const loadingMsg = this.taskListEl.createEl("p", { text: "Loading tasks…" });
            loadingMsg.style.cssText = "text-align: center; color: var(--text-muted); font-size: var(--font-ui-small); margin: 20px 0;";
            try {
                const email  = this.plugin.settings.userEmail;
                const params = email
                    ? `?assigned_email=${encodeURIComponent(email)}&owner_email=${encodeURIComponent(email)}`
                    : '';
                const res   = await this.plugin.apiRequest(`tasks${params}`);
                this.cachedTasks = res.data || [];
                await this.plugin.persistTaskCache(this.cachedTasks);
                loadingMsg.remove();
            } catch (e) {
                loadingMsg.setText("Could not load tasks.");
                return;
            }
            this.renderTaskList();
        }
    }

    private renderForm(wrapper: HTMLElement, mountContainer: HTMLElement) {
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
        titleIn.style.cssText = S.input;
        titleIn.value = this.currentTitle;
        titleIn.oninput = () => { this.currentTitle = titleIn.value; };
        // Only autofocus when the form is first opened, not on every re-mount
        if (this.formJustOpened) {
            this.formJustOpened = false;
            setTimeout(() => titleIn.focus(), 0);
        }

        // Description
        const descIn = formContainer.createEl("textarea", { placeholder: "Description (optional)..." });
        descIn.style.cssText = "width: 100%; height: 60px; font-size: var(--font-ui-small); box-sizing: border-box; resize: none;";
        descIn.value = this.currentDesc;
        descIn.oninput = () => { this.currentDesc = descIn.value; };

        // Project selector
        if (this.projects.length > 0) {
            const projectSel = formContainer.createEl("select");
            projectSel.style.cssText = S.input;
            projectSel.createEl("option", { text: "No project", value: "" }).selected = !this.currentProjectId;
            this.projects.forEach((p: any) => {
                const opt = projectSel.createEl("option", { text: p.name, value: p.id });
                if (p.id === this.currentProjectId) opt.selected = true;
            });
            projectSel.onchange = () => { this.currentProjectId = projectSel.value; };
        }

        // Control row: status | cancel | save
        const controlRow = formContainer.createDiv();
        controlRow.style.cssText = "display: flex; gap: 6px; align-items: center;";

        const statusSel = controlRow.createEl("select");
        statusSel.style.cssText = "flex: 1; height: 30px; font-size: var(--font-ui-small);";
        this.statuses.forEach((s: any) => {
            const opt = statusSel.createEl("option", { text: s.label, value: s.label });
            if (s.label === this.currentStatus) opt.selected = true;
        });
        statusSel.onchange = () => { this.currentStatus = statusSel.value; };

        const cancelBtn = controlRow.createEl("button", { text: "Cancel" });
        cancelBtn.style.cssText = "height: 30px; font-size: var(--font-ui-small); padding: 0 8px;";
        cancelBtn.onclick = () => {
            this.showForm = false;
            this.editingTaskId = null;
            this.currentTitle = "";
            this.currentDesc = "";
            this.currentProjectId = "";
            this.mount(mountContainer);
        };

        const saveBtn = controlRow.createEl("button", {
            text: this.editingTaskId ? "Save" : "Add",
            cls: "mod-cta"
        });
        saveBtn.style.cssText = "height: 30px; font-size: var(--font-ui-small); padding: 0 12px;";
        saveBtn.onclick = async () => {
            if (!this.currentTitle.trim()) { new Notice("Title is required"); return; }

            const payload: any = {
                title: this.currentTitle,
                description: this.currentDesc || null,
                assigned_email: this.plugin.settings.userEmail,
                status: this.currentStatus,
            };

        if (this.currentProjectId) payload.project_id = this.currentProjectId;
            if (this.currentDueAt)     payload.due_at = new Date(this.currentDueAt).toISOString();

            try {
                const isNew = !this.editingTaskId;
                if (this.editingTaskId) {
                    const email = this.plugin.settings.userEmail;
                    const qs = email
                        ? `?assigned_email=${encodeURIComponent(email)}&owner_email=${encodeURIComponent(email)}`
                        : '';
                    await this.plugin.apiRequest(`tasks/${this.editingTaskId}${qs}`, 'PUT', payload);
                    new Notice("Task updated");
                } else {
                    await this.plugin.apiRequest('tasks', 'POST', payload);
                    new Notice("Task added");
                }

                // Optionally create a Google Calendar event via the calendar plugin
                const calPlugin = this.plugin.calPlugin();
                if (calPlugin && this.plugin.settings.scheduleToCalendar && this.currentDueAt && isNew) {
                    try {
                        const calId = this.plugin.settings.calendarId || calPlugin.getDefaultCalendarId();
                        const startDate = new Date(this.currentDueAt);
                        const endDate   = new Date(
                            startDate.getTime() +
                            (this.plugin.settings.defaultTaskDuration ?? 30) * 60 * 1000
                        );
                        await calPlugin.createCalendarEvent(
                            calId,
                            this.currentTitle,
                            this.currentDesc || null,
                            startDate.toISOString(),
                            endDate.toISOString(),
                        );
                        new Notice("📅 Calendar event created");
                    } catch (calErr) {
                        console.error("Calendar event creation failed", calErr);
                        new Notice("Task saved, but calendar event failed");
                    }
                }

                this.showForm = false;
                this.editingTaskId = null;
                this.currentTitle = "";
                this.currentDesc = "";
                this.currentProjectId = "";
                this.currentDueAt = "";
                await this.mount(mountContainer);
            } catch (e) {
                new Notice("Failed to save task");
                console.error(e);
            }
        };
    }

    private renderTaskList() {
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
            const empty = this.taskListEl.createEl("p", { text: "No tasks found." });
            empty.style.cssText = "text-align: center; color: var(--text-muted); font-size: var(--font-ui-small); margin: 20px 0;";
            return;
        }

        tasks.forEach((task: any) => {
            const statusInfo   = this.statuses.find((s: any) => s.label === task.status);
            const statusColor  = statusInfo?.colour || 'var(--text-muted)';
            const isCompleted  = task.status?.toLowerCase() === 'completed';
            const projectName  = task.project_id
                ? (this.projects.find((p: any) => p.id === task.project_id)?.name ?? null)
                : null;

            const editAction = () => {
                this.editingTaskId   = task.id;
                this.currentTitle    = task.title;
                this.currentDesc     = task.description || "";
                this.currentStatus   = task.status;
                this.currentProjectId = task.project_id || "";
                this.showForm        = true;
                this.formJustOpened  = true;
                this.mount(this.mountContainer!);
            };

            const item = new Setting(this.taskListEl!).addExtraButton(btn => {
                btn.setIcon("trash").setTooltip("Delete").onClick(async () => {
                    if (confirm("Delete task?")) {
                        try {
                            const email = this.plugin.settings.userEmail;
                            const qs = email
                                ? `?assigned_email=${encodeURIComponent(email)}&owner_email=${encodeURIComponent(email)}`
                                : '';
                            await this.plugin.apiRequest(`tasks/${task.id}${qs}`, 'DELETE');
                            // Remove from cache and redraw without a full API re-fetch
                            this.cachedTasks = this.cachedTasks.filter((t: any) => t.id !== task.id);
                            this.renderTaskList();
                        } catch (e) {
                            new Notice(`Failed to delete task (${e.status ?? 'error'})`);
                            console.error("Delete failed", e);
                        }
                    }
                });
            });

            item.settingEl.style.cssText = "padding: 3px 0; border: none; min-height: auto;";
            if (isCompleted) item.settingEl.style.opacity = "0.5";

            const nameEl = item.nameEl;
            nameEl.empty();
            nameEl.style.cssText = [
                "font-size: var(--font-ui-small)",
                "display: flex",
                "align-items: center",
                "gap: 8px",
                "cursor: pointer",
                "flex: 1",
                "min-width: 0",
            ].join("; ");
            nameEl.title = "Edit task";
            nameEl.onclick = editAction;

            const dot = document.createElement("div");
            dot.style.cssText = `width: 7px; height: 7px; border-radius: 50%; background-color: ${statusColor}; flex-shrink: 0;`;
            dot.title = task.status ?? "";
            nameEl.appendChild(dot);

            const titleSpan = document.createElement("span");
            titleSpan.textContent = task.title;
            titleSpan.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
            if (isCompleted) {
                titleSpan.style.textDecoration = "line-through";
                titleSpan.style.color = "var(--text-muted)";
            }
            nameEl.appendChild(titleSpan);

            if (projectName) {
                const badge = document.createElement("span");
                badge.textContent = projectName;
                badge.style.cssText = [
                    "font-size: var(--font-ui-smaller)",
                    "color: var(--text-muted)",
                    "background: var(--background-modifier-border)",
                    "border-radius: var(--radius-s)",
                    "padding: 1px 5px",
                    "white-space: nowrap",
                    "flex-shrink: 0",
                ].join("; ");
                nameEl.appendChild(badge);
            }
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects pane
// ─────────────────────────────────────────────────────────────────────────────

class ProjectsPane {
    private plugin: MyTaskPlugin;
    private selectedProject: any | null = null;
    private showNewProjectForm: boolean = false;
    private newProjectName: string = "";
    private newProjectDesc: string = "";
    private cachedProjectTasks: any[] = [];
    private projectTaskListEl: HTMLElement | null = null;
    private statuses: any[] = [];

    constructor(plugin: MyTaskPlugin) {
        this.plugin = plugin;
    }

    async mount(container: HTMLElement) {
        container.empty();
        this.projectTaskListEl = null;

        const metaPromise     = this.plugin.metaData ? Promise.resolve() : this.plugin.fetchMeta();
        const projectsPromise = this.plugin.fetchProjects();
        await Promise.all([metaPromise, projectsPromise]);

        this.statuses = this.plugin.metaData?.statuses || [];
        const projects = this.plugin.projects || [];

        const wrapper = container.createDiv({
            attr: { style: "padding: 10px; display: flex; flex-direction: column; gap: 8px;" }
        });

        // ── BACK BUTTON (when a project is open) ──────────────────────────────
        if (this.selectedProject) {
            await this.renderProjectDetail(wrapper, container, projects);
            return;
        }

        // ── TOOLBAR: + new project ────────────────────────────────────────────
        const toolbar = wrapper.createDiv();
        toolbar.style.cssText = "display: flex; align-items: center; gap: 6px;";

        const toolbarLabel = toolbar.createEl("span");
        toolbarLabel.style.cssText = "flex: 1; font-size: var(--font-ui-small); color: var(--text-muted);";
        toolbarLabel.textContent = projects.length + " project" + (projects.length !== 1 ? "s" : "");

        const addBtn = toolbar.createEl("button", { text: "+" });
        addBtn.style.cssText = [
            "height: 26px",
            "width: 26px",
            "font-size: 16px",
            "line-height: 1",
            "padding: 0",
            "border: none",
            "border-radius: var(--radius-s)",
            "background: var(--interactive-accent)",
            "color: var(--text-on-accent)",
            "cursor: pointer",
            "flex-shrink: 0",
        ].join("; ");
        addBtn.title = "New project";
        addBtn.onclick = () => {
            this.showNewProjectForm = !this.showNewProjectForm;
            this.mount(container);
        };

        // ── NEW PROJECT FORM ──────────────────────────────────────────────────
        if (this.showNewProjectForm) {
            const formLabel = wrapper.createEl("p");
            formLabel.style.cssText = [
                "margin: 0",
                "font-size: var(--font-ui-smaller)",
                "font-weight: 600",
                "letter-spacing: 0.05em",
                "text-transform: uppercase",
                "color: var(--text-muted)",
            ].join("; ");
            formLabel.setText("New project");

            const formEl = wrapper.createDiv();
            formEl.style.cssText = [
                "background: var(--background-secondary)",
                "border-radius: var(--radius-m)",
                "padding: 10px",
                "display: flex",
                "flex-direction: column",
                "gap: 6px",
                "box-shadow: var(--shadow-s)",
            ].join("; ");

            const nameIn = formEl.createEl("input", { type: "text", placeholder: "Project name..." });
            nameIn.style.cssText = S.input;
            nameIn.value = this.newProjectName;
            nameIn.oninput = () => { this.newProjectName = nameIn.value; };
            setTimeout(() => nameIn.focus(), 0);

            const descIn = formEl.createEl("textarea", { placeholder: "Description (optional)..." });
            descIn.style.cssText = "width: 100%; height: 60px; font-size: var(--font-ui-small); box-sizing: border-box; resize: none;";
            descIn.value = this.newProjectDesc;
            descIn.oninput = () => { this.newProjectDesc = descIn.value; };

            const btnRow = formEl.createDiv();
            btnRow.style.cssText = "display: flex; gap: 6px; justify-content: flex-end;";

            const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
            cancelBtn.style.cssText = "height: 30px; font-size: var(--font-ui-small); padding: 0 8px;";
            cancelBtn.onclick = () => {
                this.showNewProjectForm = false;
                this.newProjectName = "";
                this.newProjectDesc = "";
                this.mount(container);
            };

            const saveBtn = btnRow.createEl("button", { text: "Create", cls: "mod-cta" });
            saveBtn.style.cssText = "height: 30px; font-size: var(--font-ui-small); padding: 0 12px;";
            saveBtn.onclick = async () => {
                if (!this.newProjectName.trim()) { new Notice("Project name is required"); return; }
                try {
                    await this.plugin.apiRequest('projects', 'POST', {
                        name: this.newProjectName,
                        description: this.newProjectDesc || null,
                    });
                    new Notice("Project created");
                    this.showNewProjectForm = false;
                    this.newProjectName = "";
                    this.newProjectDesc = "";
                    await this.plugin.fetchProjects();
                    this.mount(container);
                } catch (e) {
                    new Notice("Failed to create project");
                    console.error(e);
                }
            };
        }

        // ── PROJECT LIST ──────────────────────────────────────────────────────
        if (projects.length === 0) {
            const empty = wrapper.createEl("p", { text: "No projects yet. Press + to create one." });
            empty.style.cssText = "text-align: center; color: var(--text-muted); font-size: var(--font-ui-small); margin: 20px 0;";
            return;
        }

        projects.forEach((project: any) => {
            const item = wrapper.createDiv();
            item.style.cssText = [
                "display: flex",
                "align-items: center",
                "justify-content: space-between",
                "padding: 7px 4px",
                "border-bottom: 1px solid var(--background-modifier-border)",
                "cursor: pointer",
                "gap: 8px",
            ].join("; ");

            item.onmouseenter = () => { item.style.background = "var(--background-modifier-hover)"; };
            item.onmouseleave = () => { item.style.background = "transparent"; };

            const left = item.createDiv();
            left.style.cssText = "display: flex; flex-direction: column; gap: 2px; min-width: 0;";

            const nameRow = left.createDiv();
            nameRow.style.cssText = "display: flex; align-items: center; gap: 6px;";

            const nameSpan = nameRow.createEl("span");
            nameSpan.textContent = project.name;
            nameSpan.style.cssText = "font-size: var(--font-ui-small); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

            const count = project.task_count ?? 0;
            const countBadge = nameRow.createEl("span");
            countBadge.textContent = String(count);
            countBadge.style.cssText = [
                "font-size: var(--font-ui-smaller)",
                "font-weight: 500",
                "min-width: 18px",
                "height: 18px",
                "line-height: 18px",
                "text-align: center",
                "border-radius: 9px",
                "padding: 0 5px",
                "flex-shrink: 0",
                count > 0
                    ? "background: var(--interactive-accent); color: var(--text-on-accent);"
                    : "background: var(--background-modifier-border); color: var(--text-muted);",
            ].join("; ");
            countBadge.title = `${count} task${count !== 1 ? "s" : ""}`;

            if (project.description) {
                const descSpan = left.createEl("span");
                descSpan.textContent = project.description;
                descSpan.style.cssText = "font-size: var(--font-ui-smaller); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
            }

            // Chevron
            const chevron = item.createEl("span");
            chevron.textContent = "›";
            chevron.style.cssText = "color: var(--text-muted); font-size: 18px; flex-shrink: 0;";

            item.onclick = () => {
                this.selectedProject = project;
                this.mount(container);
            };
        });
    }

    private async renderProjectDetail(wrapper: HTMLElement, container: HTMLElement, projects: any[]) {
        // ── BACK + TITLE ──────────────────────────────────────────────────────
        const header = wrapper.createDiv();
        header.style.cssText = "display: flex; align-items: center; gap: 8px;";

        const backBtn = header.createEl("button", { text: "‹" });
        backBtn.style.cssText = [
            S.btnMuted,
            "height: 28px",
            "width: 28px",
            "font-size: 18px",
            "padding: 0",
        ].join("; ");
        backBtn.title = "Back to projects";
        backBtn.onclick = () => {
            this.selectedProject = null;
            this.cachedProjectTasks = [];
            this.mount(container);
        };

        const titleEl = header.createEl("span");
        titleEl.textContent = this.selectedProject.name;
        titleEl.style.cssText = "font-size: var(--font-ui-small); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

        if (this.selectedProject.description) {
            const descEl = wrapper.createEl("p");
            descEl.textContent = this.selectedProject.description;
            descEl.style.cssText = "margin: 0; font-size: var(--font-ui-smaller); color: var(--text-muted);";
        }

        // ── PROJECT TASK LIST ─────────────────────────────────────────────────
        this.projectTaskListEl = wrapper.createDiv();

        try {
            const email = this.plugin.settings.userEmail;
            const params = new URLSearchParams({ project_id: this.selectedProject.id });
            // owner_email unlocks visibility of private projects in the API.
            // assigned_email is included for clients with can_lookup_assigned_tasks.
            if (email) {
                params.set('assigned_email', email);
                params.set('owner_email', email);
            }
            const res = await this.plugin.apiRequest(`tasks?${params.toString()}`);
            this.cachedProjectTasks = res.data || [];
        } catch (e) {
            this.projectTaskListEl.createEl("p", { text: "Error loading tasks." });
            return;
        }

        this.renderProjectTaskList(projects);
    }

    private renderProjectTaskList(projects: any[]) {
        if (!this.projectTaskListEl) return;
        this.projectTaskListEl.empty();

        if (this.cachedProjectTasks.length === 0) {
            const empty = this.projectTaskListEl.createEl("p", { text: "No tasks in this project." });
            empty.style.cssText = "text-align: center; color: var(--text-muted); font-size: var(--font-ui-small); margin: 20px 0;";
            return;
        }

        this.cachedProjectTasks.forEach((task: any) => {
            const statusInfo  = this.statuses.find((s: any) => s.label === task.status);
            const statusColor = statusInfo?.colour || 'var(--text-muted)';
            const isCompleted = task.status?.toLowerCase() === 'completed';

            const item = new Setting(this.projectTaskListEl!);
            item.settingEl.style.cssText = "padding: 3px 0; border: none; min-height: auto;";
            if (isCompleted) item.settingEl.style.opacity = "0.5";

            const nameEl = item.nameEl;
            nameEl.empty();
            nameEl.style.cssText = "font-size: var(--font-ui-small); display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;";

            const dot = document.createElement("div");
            dot.style.cssText = `width: 7px; height: 7px; border-radius: 50%; background-color: ${statusColor}; flex-shrink: 0;`;
            dot.title = task.status ?? "";
            nameEl.appendChild(dot);

            const titleSpan = document.createElement("span");
            titleSpan.textContent = task.title;
            titleSpan.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
            if (isCompleted) {
                titleSpan.style.textDecoration = "line-through";
                titleSpan.style.color = "var(--text-muted)";
            }
            nameEl.appendChild(titleSpan);
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings tab
// ─────────────────────────────────────────────────────────────────────────────

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
            .setName('User Email')
            .setDesc('Tasks are fetched and created for this email address')
            .addText(t => t.setValue(this.plugin.settings.userEmail).onChange(async v => {
                this.plugin.settings.userEmail = v;
                await this.plugin.saveSettings();
            }));
    }
}