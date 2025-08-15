# Obsidian View Mode Plugin

A powerful Obsidian plugin that automatically controls file view modes and enforces editing restrictions based on YAML frontmatter or folder-level settings. Perfect for workflows where certain files need to be protected from editing or automatically set to specific view modes.

## Features

- **Automatic View Mode Control**: Set files to read-only, edit, or locked modes automatically
- **YAML Frontmatter Support**: Control view modes per-file using frontmatter properties
- **Folder-Level Settings**: Apply view modes to entire folders and subfolders
- **File Locking**: Completely prevent editing of sensitive or reference files
- **Smart Enforcement**: Automatically prevents mode changes and hides edit buttons for locked files
- **Temporary Unlocking**: Temporarily unlock files for editing when needed
- **Flexible Configuration**: Customize the frontmatter property name and notification settings

## How It Works

The plugin automatically detects and applies view modes when files are opened, based on two priority levels:

1. **YAML Frontmatter** (highest priority): Individual file control using a configurable property
2. **Folder Settings**: Automatic application to all files in configured folders

The plugin continuously monitors and enforces these settings, preventing unauthorized mode changes and editing.

## View Modes

### Available Modes

- **`read`**: Read-only mode - file opens in preview mode and cannot be edited
- **`edit`**: Edit mode using user's preferred editing style (source or live preview)
- **`edit-source`**: Force source mode editing
- **`edit-preview`**: Force live preview editing
- **`lock`**: Completely locked - file opens in preview mode and cannot be modified

### Mode Hierarchy

Files can be controlled at two levels:
- **File-level**: Using YAML frontmatter (overrides folder settings)
- **Folder-level**: Applied to all files in a specific folder path

## Installation

### From Obsidian Community Plugins
1. Open Obsidian Settings → Community Plugins
2. Turn off Safe mode
3. Click "Browse" and search for "View Mode"
4. Click "Install" then "Enable"

## Configuration

### Basic Settings

1. Go to **Settings → Community Plugins → View Mode**
2. Configure the following options:

#### Meta Property Name
The YAML frontmatter property used to control view mode. Default is `view_mode`.

**Examples:**
```yaml
---
view_mode: read
---
```

```yaml
---
ViewStyle: lock
---
```

```yaml
---
mode: edit-source
---
```

#### Show Mode Change Notifications
Toggle whether to show notifications when view modes change. When disabled, mode changes happen silently.

### Folder View Modes

Configure automatic view modes for entire folders:

1. Click **"+ Add folder"** in the settings
2. Enter the folder path (e.g., "Daily Notes", "Projects/Work")
3. Select the desired view mode
4. Save settings

**Folder Path Examples:**
- `Daily Notes` - applies to files in the "Daily Notes" folder
- `Projects/Work` - applies to files in the "Projects/Work" subfolder
- `Reference` - applies to all files in the "Reference" folder

## Usage Examples

### Example 1: Reference Documents
Set all files in your "Reference" folder to read-only mode:

1. In settings, add folder "Reference" with mode "read"
2. All files in this folder will automatically open in read-only mode
3. Users cannot accidentally edit important reference materials

### Example 2: Template Protection
Protect template files from editing:

```yaml
---
view_mode: lock
---
```

Template files will be completely locked and cannot be modified, even temporarily.

### Example 3: Work vs Personal Notes
Different editing modes for different contexts:

- **Work Projects** folder: Set to "edit-source" for structured editing
- **Personal Notes** folder: Set to "edit" for flexible editing
- **Archived** folder: Set to "read" to prevent accidental changes

### Example 4: Collaborative Workflows
Use "lock" mode for files that are being reviewed or are in final state:

```yaml
---
view_mode: lock
status: final
---
```

### Example 5: Custom Property Names
If you prefer different frontmatter properties:

1. Set "Meta property name" to "ViewStyle" in settings
2. Use in your files:

```yaml
---
ViewStyle: edit-preview
---
```

## Commands

The plugin adds several commands to Obsidian:

- **Unlock File**: Temporarily unlock a locked file for editing
  - Only appears when viewing a locked file
  - File automatically re-locks when navigating away

## How It Enforces Settings

### Automatic Enforcement
- **File Opening**: View mode is applied immediately when files are opened
- **Continuous Monitoring**: Plugin checks and enforces settings every second
- **Mode Change Prevention**: Blocks attempts to change view modes for locked files
- **Button Hiding**: Edit buttons are automatically hidden for locked files

### Lock Enforcement
- **Preview Mode Only**: Locked files are forced to stay in preview mode
- **Edit Prevention**: All editing attempts are blocked
- **Visual Feedback**: Clear notifications when editing is prevented

### Temporary Unlocking
- **Command Palette**: Use "Unlock File" command to temporarily unlock
- **Session-Based**: Unlock persists only while viewing the file
- **Auto-Relock**: File automatically re-locks when navigating away

### Contributing
Contributions are welcome! Please feel free to submit issues and pull requests.

## Support

- **GitHub Issues**: Report bugs or request features
- **GitHub Discussions**: Ask questions and share workflows
- **Funding**: Support development through the funding links in the plugin

## Changelog

### Version 1.0.0
- Initial release with core view mode functionality
- YAML frontmatter support
- Folder-level view mode settings
- File locking and enforcement
- Temporary unlocking capability
- Comprehensive settings interface
