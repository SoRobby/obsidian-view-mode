import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from 'obsidian';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
	metaPropertyName: string;
	showModeChangeNotification: boolean;
	folderViewModes: FolderViewMode[];
}

interface FolderViewMode {
	folderPath: string;
	viewMode: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	metaPropertyName: 'view_mode',
	showModeChangeNotification: false,
	folderViewModes: []
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	private livePreviewConfig: boolean = true;
	private lockedFiles: Set<string> = new Set();
	private temporarilyUnlockedFiles: Set<string> = new Set();

	async onload() {
		await this.loadSettings();
		await this.refreshEditConfig();

		// Initialize locked files for any currently open files
		setTimeout(() => {
			this.initializeLockedFiles();
			this.updateEditButtonsVisibility();
		}, 500);

		// Add unlock file command
		this.addCommand({
			id: 'unlock-file',
			name: 'Unlock file',
			checkCallback: (checking: boolean) => {
				// Only show command if there's an active markdown view that is locked
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView && markdownView.file && this.isFileLocked(markdownView.file.path)) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new UnlockFileModal(this.app, this, markdownView.file).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
				return false;
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// Register file-open listener to set view mode immediately when file opens
		this.registerEvent(
			this.app.workspace.on('file-open', async (file: TFile | null) => {
				if (!file || file.extension !== 'md') return;

				// Use a small delay to ensure the view is ready
				setTimeout(async () => {
					const fileCache = this.app.metadataCache.getFileCache(file);
					let viewMode: string | undefined;

					// First check for frontmatter view mode
					if (fileCache && fileCache.frontmatter) {
						viewMode = fileCache.frontmatter[this.settings.metaPropertyName];
					}

					// If no frontmatter view mode, check for folder-specific view mode
					if (!viewMode) {
						viewMode = this.getFolderViewMode(file.path);
					}

					if (!viewMode) return;

					const view = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (!view || view.file !== file) return;

					await this.setViewMode(view, viewMode);
					this.updateEditButtonsVisibility();
				}, 100);
			})
		);

		// Register event listeners to prevent mode changes for locked files
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.checkAndEnforceLockedFiles();
			})
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.checkAndEnforceLockedFiles();
				this.handleLeafChange();
			})
		);

		// Listen for view state changes to catch mode switches
		this.registerEvent(
			this.app.workspace.on('resize', () => {
				this.checkAndEnforceLockedFiles();
			})
		);

		// Add a more frequent check for locked files
		this.registerInterval(window.setInterval(() => {
			// Skip enforcement if any files are temporarily unlocked
			if (this.temporarilyUnlockedFiles.size === 0) {
				this.checkAndEnforceLockedFiles();
			}
			this.updateEditButtonsVisibility();
		}, 1000)); // Check every second

		// Listen for metadata cache updates to handle frontmatter changes
		this.registerEvent(
			this.app.metadataCache.on('changed', (file: TFile) => {
				if (file.extension === 'md') {
					setTimeout(() => this.checkAndEnforceLockedFiles(), 100);
				}
			})
		);

		// Listen for view state changes to prevent mode changes for locked files
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				// Add a small delay to catch the state change
				setTimeout(() => {
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (activeView && activeView.file) {
						const filePath = activeView.file.path;
						const isLocked = this.lockedFiles.has(filePath);
						const isTemporarilyUnlocked = this.temporarilyUnlockedFiles.has(filePath);

						if (isLocked && !isTemporarilyUnlocked) {
							const currentState = activeView.getState();
							if (currentState.mode !== 'preview') {
								console.log(`Preventing mode change for locked file: ${activeView.file.basename}`);
								currentState.mode = 'preview';
								activeView.setState(currentState, { history: false });
							}
						}
					}
				}, 10);
			})
		);

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			// Check if the click might be on an edit mode button
			const target = evt.target as HTMLElement;
			if (target && (target.closest('.clickable-icon') || target.closest('.view-action'))) {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file && this.isFileLocked(activeView.file.path)) {
					// Check if this is an edit mode button
					const button = target.closest('.clickable-icon, .view-action') as HTMLElement;
					if (button && (button.getAttribute('aria-label')?.includes('Edit') ||
						button.getAttribute('aria-label')?.includes('Preview') ||
						button.classList.contains('view-action-edit') ||
						button.classList.contains('view-action-preview'))) {
						evt.preventDefault();
						evt.stopPropagation();
						new Notice(`File "${activeView.file.basename}" is locked and cannot be modified`);
						return;
					}
				}
			}
		});

		// Listen for keyboard shortcuts that might change view mode
		this.registerDomEvent(document, 'keydown', (evt: KeyboardEvent) => {
			// Check for common shortcuts that switch view modes
			if ((evt.ctrlKey || evt.metaKey) && evt.key === 'e') {
				// Ctrl/Cmd + E is often used to toggle edit mode
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file && this.isFileLocked(activeView.file.path)) {
					evt.preventDefault();
					evt.stopPropagation();
					new Notice(`File "${activeView.file.basename}" is locked and cannot be modified`);
					return;
				}
			}
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	async refreshEditConfig() {
		try {
			const appConfig = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/app.json`));
			this.livePreviewConfig = appConfig.livePreview ?? true;
		} catch (error) {
			console.error('Error reading app config:', error);
			this.livePreviewConfig = true; // Default to live preview
		}
	}

	getFolderViewMode(filePath: string): string | undefined {
		// Remove the file name to get the folder path
		const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));

		// Check if any configured folder path matches
		for (const folderViewMode of this.settings.folderViewModes) {
			if (folderPath === folderViewMode.folderPath || folderPath.startsWith(folderViewMode.folderPath + '/')) {
				return folderViewMode.viewMode;
			}
		}

		return undefined;
	}

	async setViewMode(view: MarkdownView, viewMode: string) {
		const mode = viewMode.toLowerCase();
		let state = view.getState();

		console.log(`Setting view mode for ${view.file?.basename} to: ${mode}`);

		// Patch the view's setState method to prevent mode changes for locked files
		this.patchViewStateMethod(view);

		switch (mode) {
			case 'read':
				state.mode = 'preview';
				if (this.settings.showModeChangeNotification) {
					new Notice(`File "${view.file?.basename}" is in read-only mode`);
				}
				break;
			case 'edit':
				// Use the user's preferred editing mode
				state.mode = 'source';
				state.source = !this.livePreviewConfig; // true for source mode, false for live preview
				if (this.settings.showModeChangeNotification) {
					new Notice(`File "${view.file?.basename}" is in edit mode (${this.livePreviewConfig ? 'live preview' : 'source'})`);
				}
				break;
			case 'edit-source':
				state.mode = 'source';
				state.source = true; // Force source mode
				if (this.settings.showModeChangeNotification) {
					new Notice(`File "${view.file?.basename}" is in source edit mode`);
				}
				break;
			case 'edit-preview':
				state.mode = 'source';
				state.source = false; // Force live preview mode
				if (this.settings.showModeChangeNotification) {
					new Notice(`File "${view.file?.basename}" is in live preview edit mode`);
				}
				break;
			case 'lock':
				state.mode = 'preview';
				const filePath = view.file?.path || '';
				this.lockedFiles.add(filePath);
				console.log(`Locked file: ${filePath}. Total locked files: ${this.lockedFiles.size}`);
				if (this.settings.showModeChangeNotification) {
					new Notice(`File "${view.file?.basename}" is locked and cannot be modified`);
				}
				break;
			default:
				// Invalid mode, ignore
				return;
		}

		await view.setState(state, { history: false });
	}

	checkAndEnforceLockedFiles() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView || !activeView.file) return;

		const filePath = activeView.file.path;
		const currentState = activeView.getState();

		// Skip enforcement if the file is temporarily unlocked
		if (this.temporarilyUnlockedFiles.has(filePath)) {
			return;
		}

		if (this.lockedFiles.has(filePath)) {
			console.log(`Checking locked file: ${activeView.file.basename}, current mode: ${currentState.mode}`);
			if (currentState.mode !== 'preview') {
				// File is locked but not in preview mode, force it back to preview
				console.log(`Forcing ${activeView.file.basename} back to preview mode`);
				currentState.mode = 'preview';
				activeView.setState(currentState, { history: false });
				new Notice(`File "${activeView.file.basename}" is locked and cannot be modified`);
			}
		}

		// Also check if the file should be locked based on frontmatter or folder settings
		const fileCache = this.app.metadataCache.getFileCache(activeView.file);
		let viewMode: string | undefined;

		// Check for frontmatter view mode
		if (fileCache && fileCache.frontmatter) {
			viewMode = fileCache.frontmatter[this.settings.metaPropertyName];
		}

		// If no frontmatter view mode, check for folder-specific view mode
		if (!viewMode) {
			viewMode = this.getFolderViewMode(activeView.file.path);
		}

		// If the file should be locked but isn't in the locked set, add it
		// But only if it's not temporarily unlocked
		if (viewMode === 'lock' && !this.lockedFiles.has(filePath) && !this.temporarilyUnlockedFiles.has(filePath)) {
			this.lockedFiles.add(filePath);
			const currentState = activeView.getState();
			if (currentState.mode !== 'preview') {
				currentState.mode = 'preview';
				activeView.setState(currentState, { history: false });
				new Notice(`File "${activeView.file.basename}" is locked and cannot be modified`);
			}
		}

		// Update button visibility after any lock state changes
		this.updateEditButtonsVisibility();
	}

	isFileLocked(filePath: string): boolean {
		return this.lockedFiles.has(filePath);
	}

	handleLeafChange() {
		// Re-lock any temporarily unlocked files when navigating away
		if (this.temporarilyUnlockedFiles.size > 0) {
			console.log(`Re-locking ${this.temporarilyUnlockedFiles.size} temporarily unlocked files`);
			this.temporarilyUnlockedFiles.clear();
		}
		this.updateEditButtonsVisibility();
	}

	updateEditButtonsVisibility() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView || !activeView.file) return;

		const isLocked = this.isFileLocked(activeView.file.path);
		const isTemporarilyUnlocked = this.temporarilyUnlockedFiles.has(activeView.file.path);

		// Find edit mode buttons in the current view
		const editButtons = document.querySelectorAll('.view-action-edit, .view-action-preview, .clickable-icon[aria-label*="Edit"], .clickable-icon[aria-label*="Preview"]');

		editButtons.forEach(button => {
			const buttonEl = button as HTMLElement;
			if (isLocked && !isTemporarilyUnlocked) {
				// Hide edit buttons for locked files
				buttonEl.style.display = 'none';
			} else {
				// Show edit buttons for unlocked files
				buttonEl.style.display = '';
			}
		});
	}

	patchViewStateMethod(view: MarkdownView) {
		// Store the original setState method
		if (!(view as any)._originalSetState) {
			(view as any)._originalSetState = view.setState.bind(view);

			// Override the setState method
			view.setState = (state: any, result: any) => {
				const filePath = view.file?.path;
				if (filePath && this.lockedFiles.has(filePath) && !this.temporarilyUnlockedFiles.has(filePath)) {
					// If the file is locked and not temporarily unlocked, prevent mode changes
					if (state.mode && state.mode !== 'preview') {
						console.log(`Blocking setState for locked file: ${view.file?.basename}`);
						state.mode = 'preview';
						new Notice(`File "${view.file?.basename}" is locked and cannot be modified`);
					}
				}

				// Call the original setState method
				return (view as any)._originalSetState(state, result);
			};
		}
	}

	unlockFile(filePath: string) {
		this.lockedFiles.delete(filePath);
		this.temporarilyUnlockedFiles.add(filePath);
		console.log(`Unlocked file: ${filePath}. Remaining locked files: ${this.lockedFiles.size}, temporarily unlocked: ${this.temporarilyUnlockedFiles.size}`);

		// Switch the file to edit mode
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView && activeView.file && activeView.file.path === filePath) {
			const state = activeView.getState();
			state.mode = 'source';
			state.source = !this.livePreviewConfig; // Use user's preferred editing mode
			activeView.setState(state, { history: false });
		}

		// Update button visibility
		this.updateEditButtonsVisibility();
	}

	initializeLockedFiles() {
		// Check all currently open markdown views
		const markdownViews = this.app.workspace.getLeavesOfType('markdown');
		markdownViews.forEach(leaf => {
			const view = leaf.view as MarkdownView;
			if (view && view.file) {
				const fileCache = this.app.metadataCache.getFileCache(view.file);
				let viewMode: string | undefined;

				// Check for frontmatter view mode
				if (fileCache && fileCache.frontmatter) {
					viewMode = fileCache.frontmatter[this.settings.metaPropertyName];
				}

				// If no frontmatter view mode, check for folder-specific view mode
				if (!viewMode) {
					viewMode = this.getFolderViewMode(view.file.path);
				}

				// If the file should be locked, add it to the locked set and enforce the lock
				if (viewMode === 'lock') {
					this.lockedFiles.add(view.file.path);
					const currentState = view.getState();
					if (currentState.mode !== 'preview') {
						currentState.mode = 'preview';
						view.setState(currentState, { history: false });
						if (this.settings.showModeChangeNotification) {
							new Notice(`File "${view.file.basename}" is locked and cannot be modified`);
						}
					}
				}
			}
		});
	}

	onunload() {
		// Clear locked files set
		this.lockedFiles.clear();
		this.temporarilyUnlockedFiles.clear();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class UnlockFileModal extends Modal {
	plugin: MyPlugin;
	file: TFile;

	constructor(app: App, plugin: MyPlugin, file: TFile) {
		super(app);
		this.plugin = plugin;
		this.file = file;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('unlock-file-modal');

		// Set modal title
		contentEl.createEl('h2', { text: 'Unlock file' });

		// Add main message
		contentEl.createEl('p', {
			text: 'Are you sure you want to unlock the file?',
		});

		// Add subnote
		contentEl.createEl('p', {
			text: 'The file will return to its locked state when you navigate away.',
			attr: { style: 'font-size: 0.8em; opacity: 0.8;' }
		});

		// Create button container
		const buttonContainer = contentEl.createEl('div', {
			cls: 'modal-button-container'
		});

		// Add Cancel button (outline style)
		const cancelButton = buttonContainer.createEl('button', {
			text: 'Cancel',
		});
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		// Add Unlock button (primary style)
		const unlockButton = buttonContainer.createEl('button', {
			text: 'Unlock',
			cls: 'mod-cta'
		});

		unlockButton.addEventListener('click', () => {
			this.close();
			this.unlockFile();
		});

		// Focus on Cancel button by default
		cancelButton.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	private unlockFile() {
		// Remove the file from the locked files set
		this.plugin.unlockFile(this.file.path);

		// Show notification
		new Notice(`File "${this.file.basename}" has been unlocked`);
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Folder view mode settings
		containerEl.createEl('h3', { text: 'File View Mode Settings' });
		containerEl.createEl('p', {
			text: 'Configure view modes for specific folders. Files in these folders will automatically use the specified view mode unless overridden by frontmatter.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Meta property name')
			.setDesc('The YAML frontmatter property name used to control view mode. Default is "view_mode". Examples: "ViewStyle", "view-format", "mode", etc.')
			.addText(text => text
				.setPlaceholder('view_mode')
				.setValue(this.plugin.settings.metaPropertyName)
				.onChange(async (value) => {
					this.plugin.settings.metaPropertyName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show mode change notification')
			.setDesc('When enabled, shows a notification when the view mode changes. When disabled, mode changes happen silently without notifications.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showModeChangeNotification)
				.onChange(async (value) => {
					this.plugin.settings.showModeChangeNotification = value;
					await this.plugin.saveSettings();
				}));

		// Folder view mode settings
		containerEl.createEl('h4', { text: 'Folder View Modes' });
		containerEl.createEl('p', {
			text: 'Configure view modes for specific folders. Files in these folders will automatically use the specified view mode unless overridden by frontmatter.',
			cls: 'setting-item-description'
		});

		// Display existing folder view modes
		this.plugin.settings.folderViewModes.forEach((folderViewMode, index) => {
			const folderSetting = new Setting(containerEl)
				.setName(`Folder ${index + 1}`)
				.addText(text => text
					.setPlaceholder('e.g., Daily Notes, Projects/Work')
					.setValue(folderViewMode.folderPath)
					.onChange(async (value) => {
						folderViewMode.folderPath = value;
						await this.plugin.saveSettings();
					}))
				.addDropdown(dropdown => dropdown
					.addOption('read', 'Read Only')
					.addOption('edit', 'Edit (User Preference)')
					.addOption('edit-source', 'Edit Source')
					.addOption('edit-preview', 'Edit Preview')
					.addOption('lock', 'Lock (Cannot be modified)')
					.setValue(folderViewMode.viewMode)
					.onChange(async (value) => {
						folderViewMode.viewMode = value;
						await this.plugin.saveSettings();
					}))
				.addExtraButton(button => button
					.setIcon('trash')
					.setTooltip('Remove folder')
					.onClick(async () => {
						this.plugin.settings.folderViewModes.splice(index, 1);
						await this.plugin.saveSettings();
						this.display(); // Refresh the settings display
					}));
		});

		// Add new folder button
		new Setting(containerEl)
			.setName('Add Folder')
			.setDesc('Add a new folder with a specific view mode')
			.addButton(button => button
				.setButtonText('+ Add folder')
				.onClick(async () => {
					this.plugin.settings.folderViewModes.push({
						folderPath: '',
						viewMode: 'read'
					});
					await this.plugin.saveSettings();
					this.display(); // Refresh the settings display
				}));
	}
}
