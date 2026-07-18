#!/bin/bash

# Configuration
EXTENSIONS=("video-speed-controller" "ext-manager" "bookmark-manager" "picture-in-picture-youtube")
OUTPUT_DIR="safari-extensions"

# Check for Xcode
if ! xcodebuild -version &> /dev/null; then
    echo "❌ Error: Xcode is not installed or not active."
    echo "   Please install Xcode from the App Store to use 'safari-web-extension-converter'."
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Loop through extensions
for ext in "${EXTENSIONS[@]}"; do
    echo "----------------------------------------"
    echo "📦 Converting: $ext"

    if [ ! -d "$ext" ]; then
        echo "⚠️  Warning: Directory '$ext' not found. Skipping."
        continue
    fi

    # Run conversion
    # Note: We use --force to overwrite if it exists, and --no-open to prevent opening Xcode for every single one immediately
    xcrun safari-web-extension-converter "$ext" --project-location "$OUTPUT_DIR/$ext-safari" --no-open --force

    if [ $? -eq 0 ]; then
        echo "✅ Successfully converted '$ext' to '$OUTPUT_DIR/$ext-safari'"
    else
        echo "❌ Failed to convert '$ext'"
    fi
done

echo "----------------------------------------"
echo "🎉 Done! Open the projects in '$OUTPUT_DIR' with Xcode to build and run them."
