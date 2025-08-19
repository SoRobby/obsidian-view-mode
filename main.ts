import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

interface ViewModeSettings {
	metaPropertyName: string;
	showModeChangeNotification: boolean;
	folderViewModes: FolderViewMode[];
	// Custom YAML property names for each view mode
	customYamlNames: {
		read: string;
		edit: string;
		editSource: string;
		editPreview: string;
		lock: string;
	};
}

type ViewMode = 'read' | 'edit' | 'edit-source' | 'edit-preview' | 'lock';

interface FolderViewMode {
	folderPath: string;
	viewMode: ViewMode;
}

// Extended MarkdownView interface to support our custom properties
interface ExtendedMarkdownView extends MarkdownView {
	_originalSetState?: (state: ViewState, result: ViewStateResult) => Promise<void>;
}

// View state types
interface ViewState {
	mode?: 'preview' | 'source';
	source?: boolean;
	[key: string]: unknown; // Allow other properties with unknown type
}

interface ViewStateResult {
	history: boolean;
	[key: string]: unknown; // Allow other properties with unknown type
}

// Types for Obsidian UI components
interface TextComponent {
	setPlaceholder(placeholder: string): TextComponent;
	setValue(value: string): TextComponent;
	onChange(callback: (value: string) => void): TextComponent;
}

interface DropdownComponent {
	addOption(value: string, display: string): DropdownComponent;
	setValue(value: string): DropdownComponent;
	onChange(callback: (value: string) => void): DropdownComponent;
}

interface ButtonComponent {
	setButtonText(text: string): ButtonComponent;
	onClick(callback: () => void): ButtonComponent;
}

interface ExtraButtonComponent {
	setIcon(icon: string): ExtraButtonComponent;
	setTooltip(tooltip: string): ExtraButtonComponent;
	onClick(callback: () => void): ExtraButtonComponent;
}

interface ToggleComponent {
	setValue(value: boolean): ToggleComponent;
	onChange(callback: (value: boolean) => void): ToggleComponent;
}

const DEFAULT_SETTINGS: ViewModeSettings = {
	metaPropertyName: 'view_mode',
	showModeChangeNotification: false,
	folderViewModes: [],
	// Custom YAML property names for each view mode
	customYamlNames: {
		read: 'read_only',
		edit: 'edit_mode',
		editSource: 'edit_source',
		editPreview: 'edit_preview',
		lock: 'locked'
	}
}

export default class ViewModePlugin extends Plugin {
	settings: ViewModeSettings;
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
		this.addSettingTab(new ViewModeSettingTab(this.app, this));

		// Register file-open listener to set view mode immediately when file opens
		this.registerEvent(
			this.app.workspace.on('file-open', async (file: TFile | null) => {
				if (!file || file.extension !== 'md') return;

				// Use a small delay to ensure the view is ready
				setTimeout(async () => {
					const fileCache = this.app.metadataCache.getFileCache(file);
					let viewMode: ViewMode | undefined;

					// First check for frontmatter view mode
					if (fileCache && fileCache.frontmatter) {
						const frontmatterValue = fileCache.frontmatter[this.settings.metaPropertyName];
						if (this.isValidViewMode(frontmatterValue)) {
							viewMode = this.convertYamlValueToViewMode(frontmatterValue as string);
						}
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

	getFolderViewMode(filePath: string): ViewMode | undefined {
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

	private isValidViewMode(value: unknown): value is ViewMode {
		// Check if the value matches any of the custom YAML property names
		if (typeof value === 'string') {
			const customNames = this.settings.customYamlNames;
			return value === customNames.read || 
				   value === customNames.edit || 
				   value === customNames.editSource || 
				   value === customNames.editPreview || 
				   value === customNames.lock;
		}
		return false;
	}

	private convertYamlValueToViewMode(value: string): ViewMode | undefined {
		const customNames = this.settings.customYamlNames;
		
		if (value === customNames.read) return 'read';
		if (value === customNames.edit) return 'edit';
		if (value === customNames.editSource) return 'edit-source';
		if (value === customNames.editPreview) return 'edit-preview';
		if (value === customNames.lock) return 'lock';
		
		return undefined;
	}

	async setViewMode(view: MarkdownView, viewMode: ViewMode) {
		const mode = viewMode.toLowerCase();
		let state = view.getState();

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
			if (currentState.mode !== 'preview') {
				// File is locked but not in preview mode, force it back to preview
				currentState.mode = 'preview';
				activeView.setState(currentState, { history: false });
				new Notice(`File "${activeView.file.basename}" is locked and cannot be modified`);
			}
		}

		// Also check if the file should be locked based on frontmatter or folder settings
		const fileCache = this.app.metadataCache.getFileCache(activeView.file);
		let viewMode: ViewMode | undefined;

		// Check for frontmatter view mode
		if (fileCache && fileCache.frontmatter) {
			const frontmatterValue = fileCache.frontmatter[this.settings.metaPropertyName];
			if (this.isValidViewMode(frontmatterValue)) {
				viewMode = this.convertYamlValueToViewMode(frontmatterValue as string);
			}
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
				buttonEl.classList.add('view-mode-hidden');
			} else {
				// Show edit buttons for unlocked files
				buttonEl.classList.remove('view-mode-hidden');
			}
		});
	}

	patchViewStateMethod(view: MarkdownView) {
		// Store the original setState method
		const extendedView = view as ExtendedMarkdownView;
		if (!extendedView._originalSetState) {
			extendedView._originalSetState = view.setState.bind(view);

			// Override the setState method
			view.setState = async (state: ViewState, result: ViewStateResult) => {
				const filePath = view.file?.path;
				if (filePath && this.lockedFiles.has(filePath) && !this.temporarilyUnlockedFiles.has(filePath)) {
					// If the file is locked and not temporarily unlocked, prevent mode changes
					if (state.mode && state.mode !== 'preview') {
						state.mode = 'preview';
						new Notice(`File "${view.file?.basename}" is locked and cannot be modified`);
					}
				}

				// Call the original setState method
				return await extendedView._originalSetState!(state, result);
			};
		}
	}

	unlockFile(filePath: string) {
		this.lockedFiles.delete(filePath);
		this.temporarilyUnlockedFiles.add(filePath);

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
				let viewMode: ViewMode | undefined;

				// Check for frontmatter view mode
				if (fileCache && fileCache.frontmatter) {
					const frontmatterValue = fileCache.frontmatter[this.settings.metaPropertyName];
					if (this.isValidViewMode(frontmatterValue)) {
						viewMode = this.convertYamlValueToViewMode(frontmatterValue as string);
					}
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

class UnlockFileModal extends Modal {
	plugin: ViewModePlugin;
	file: TFile;

	constructor(app: App, plugin: ViewModePlugin, file: TFile) {
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
			cls: 'modal-subnote'
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

class ViewModeSettingTab extends PluginSettingTab {
	plugin: ViewModePlugin;

	constructor(app: App, plugin: ViewModePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.addClass('view-mode-settings');

		// Folder view mode settings
		containerEl.createEl('h3', { text: 'File View Mode Settings' });
		containerEl.createEl('p', {
			text: 'Configure view modes for specific folders. Files in these folders will automatically use the specified view mode unless overridden by frontmatter.',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Meta property name')
			.setDesc('The YAML frontmatter property name used to control view mode. Default is "view_mode". Examples: "ViewStyle", "view-format", "mode", etc.')
			.addText((text: TextComponent) => text
				.setPlaceholder('view_mode')
				.setValue(this.plugin.settings.metaPropertyName)
				.onChange(async (value: string) => {
					this.plugin.settings.metaPropertyName = value;
					await this.plugin.saveSettings();
				}));

		// Custom YAML property names section
		const customYamlSection = containerEl.createEl('div', { cls: 'custom-yaml-section' });
		customYamlSection.createEl('h4', { text: 'Custom YAML Property Names' });
		customYamlSection.createEl('p', {
			text: 'Configure custom YAML property values for each view mode. These values will be used in your frontmatter instead of the default values.',
			cls: 'setting-item-description'
		});

		new Setting(customYamlSection)
			.setName('Read Only Mode')
			.setDesc('YAML value for read-only mode')
			.addText((text: TextComponent) => text
				.setPlaceholder('read')
				.setValue(this.plugin.settings.customYamlNames.read)
				.onChange(async (value: string) => {
					this.plugin.settings.customYamlNames.read = value;
					await this.plugin.saveSettings();
				}));

		new Setting(customYamlSection)
			.setName('Edit Mode')
			.setDesc('YAML value for edit mode (user preference)')
			.addText((text: TextComponent) => text
				.setPlaceholder('edit')
				.setValue(this.plugin.settings.customYamlNames.edit)
				.onChange(async (value: string) => {
					this.plugin.settings.customYamlNames.edit = value;
					await this.plugin.saveSettings();
				}));

		new Setting(customYamlSection)
			.setName('Edit Source Mode')
			.setDesc('YAML value for source edit mode')
			.addText((text: TextComponent) => text
				.setPlaceholder('edit-source')
				.setValue(this.plugin.settings.customYamlNames.editSource)
				.onChange(async (value: string) => {
					this.plugin.settings.customYamlNames.editSource = value;
					await this.plugin.saveSettings();
				}));

		new Setting(customYamlSection)
			.setName('Edit Preview Mode')
			.setDesc('YAML value for live preview edit mode')
			.addText((text: TextComponent) => text
				.setPlaceholder('edit-preview')
				.setValue(this.plugin.settings.customYamlNames.editPreview)
				.onChange(async (value: string) => {
					this.plugin.settings.customYamlNames.editPreview = value;
					await this.plugin.saveSettings();
				}));

		new Setting(customYamlSection)
			.setName('Lock Mode')
			.setDesc('YAML value for locked mode')
			.addText((text: TextComponent) => text
				.setPlaceholder('lock')
				.setValue(this.plugin.settings.customYamlNames.lock)
				.onChange(async (value: string) => {
					this.plugin.settings.customYamlNames.lock = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show mode change notification')
			.setDesc('When enabled, shows a notification when the view mode changes. When disabled, mode changes happen silently without notifications.')
			.addToggle((toggle: ToggleComponent) => toggle
				.setValue(this.plugin.settings.showModeChangeNotification)
				.onChange(async (value: boolean) => {
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
				.addText((text: TextComponent) => text
					.setPlaceholder('e.g., Daily Notes, Projects/Work')
					.setValue(folderViewMode.folderPath)
					.onChange(async (value: string) => {
						folderViewMode.folderPath = value;
						await this.plugin.saveSettings();
					}))
				.addDropdown((dropdown: DropdownComponent) => dropdown
					.addOption('read', 'Read Only')
					.addOption('edit', 'Edit (User Preference)')
					.addOption('edit-source', 'Edit Source')
					.addOption('edit-preview', 'Edit Preview')
					.addOption('lock', 'Lock (Cannot be modified)')
					.setValue(folderViewMode.viewMode)
					.onChange(async (value: string) => {
						folderViewMode.viewMode = value as ViewMode;
						await this.plugin.saveSettings();
					}))
				.addExtraButton((button: ExtraButtonComponent) => button
					.setIcon('trash')
					.setTooltip('Remove folder')
					.onClick(async () => {
						this.plugin.settings.folderViewModes.splice(index, 1);
						await this.plugin.saveSettings();
						this.display(); // Refresh the settings display
					}));
			
			// Add CSS class to the setting container
			folderSetting.settingEl.addClass('folder-view-mode-item');
		});

		// Add new folder button
		const addFolderSetting = new Setting(containerEl)
			.setName('Add Folder')
			.setDesc('Add a new folder with a specific view mode')
			.addButton((button: ButtonComponent) => button
				.setButtonText('+ Add folder')
				.onClick(async () => {
					this.plugin.settings.folderViewModes.push({
						folderPath: '',
						viewMode: 'read'
					});
					await this.plugin.saveSettings();
					this.display(); // Refresh the settings display
				}));
		
		// Add CSS class to the add folder setting
		addFolderSetting.settingEl.addClass('add-folder-button');
	}
}
