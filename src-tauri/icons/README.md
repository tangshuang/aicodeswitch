# Tauri Icons

This directory contains the application icons for the Tauri build.

## Generating Icons

To generate all required icon formats, you need a source icon image (PNG format, at least 512x512 pixels recommended).

### Steps:

1. Place your source icon image in this directory (e.g., `app-icon.png`)

2. Run the Tauri icon generator:
   ```bash
   npm run tauri:icon path/to/your/icon.png
   ```

   Or directly:
   ```bash
   yarn tauri icon src-tauri/icons/app-icon.png
   ```

3. The command will automatically generate all required icon formats:
   - `32x32.png` - Small icon
   - `128x128.png` - Medium icon
   - `128x128@2x.png` - Retina display icon
   - `icon.icns` - macOS icon bundle
   - `icon.ico` - Windows icon

## Required Icon Formats

- **32x32.png**: Small size icon
- **128x128.png**: Standard size icon
- **128x128@2x.png**: High DPI icon
- **icon.icns**: macOS application icon
- **icon.ico**: Windows application icon

## Icon Design Guidelines

- Use a simple, recognizable design
- Ensure the icon looks good at small sizes (32x32)
- Use high contrast colors
- Avoid fine details that may not be visible at small sizes
- Test the icon on both light and dark backgrounds

## Temporary Solution

If you don't have a custom icon yet, you can use Tauri's default icon generation by running:

```bash
npm run tauri:icon
```

This will prompt you to provide a source image or use a default placeholder.
