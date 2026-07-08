(function() {
  if (window.__dailyReaderViewLoaded) {
    return;
  }
  window.__dailyReaderViewLoaded = true;

  let readerActive = false;
  let overlay = null;
  let onKeydown = null;
  let currentSettings = {
    theme: 'theme-paper', // Default to Paper as requested
    font: 'font-preview-charter', // Serif fits paper better
    fontSize: 18
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "toggle-reader-view") {
      toggleReader();
    }
  });

  function toggleReader() {
    if (readerActive) {
      removeOverlay();
    } else {
      showOverlay();
    }
  }

  function showOverlay() {
    const documentClone = document.cloneNode(true);
    const reader = new Readability(documentClone);
    const article = reader.parse();

    if (!article || !article.content) {
      alert("Reader View not available for this page.");
      return;
    }

    // --- Featured Image Extraction ---
    let featuredImage = null;
    try {
      // 1. Try OpenGraph
      featuredImage = document.querySelector('meta[property="og:image"]')?.content;
      
      // 2. Fallback: Find largest image above fold
      if (!featuredImage) {
        const images = Array.from(document.querySelectorAll('img'));
        // Sort by area, favoring images near the top
        const candidate = images
          .filter(img => img.naturalWidth > 400 && img.naturalHeight > 200 && img.getBoundingClientRect().top < 800)
          .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];
        
        if (candidate) featuredImage = candidate.src;
      }

      // 3. Avoid duplicates: Check if Readability already captured this image
      if (featuredImage && article.content.includes(featuredImage)) {
        featuredImage = null; 
      }
    } catch (e) {}

    readerActive = true;
    overlay = document.createElement('div');
    overlay.id = 'daily-reader-overlay';
    
    // Apply default settings
    overlay.classList.add(currentSettings.theme);
    overlay.style.setProperty('--font-size', currentSettings.fontSize + 'px');
    applyFont(currentSettings.font);

    // Initial controls HTML
    overlay.innerHTML = `
      <div id="reader-control-bar">
        <div id="reader-controls">
          <button class="control-btn" id="appearance-toggle" title="Text Appearance">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 19V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13M9 19V9h6v10M9 14h6" />
              <text x="6" y="16" font-family="sans-serif" font-size="10" stroke="none" fill="currentColor">Aa</text>
            </svg>
          </button>
          <div class="control-separator"></div>
          <button class="control-btn" id="reader-close-btn" title="Close Reader View">✕</button>
        </div>

        <div id="appearance-menu">
          <!-- Font Size -->
          <div class="font-size-control">
            <div class="font-size-btn small-a" id="font-dec">A</div>
            <div class="font-size-btn large-a" id="font-inc">A</div>
          </div>
          
          <!-- Themes -->
          <div class="theme-selector">
            <div class="theme-option theme-btn-white" data-theme="theme-white" title="White"></div>
            <div class="theme-option theme-btn-paper" data-theme="theme-paper" title="Paper"></div>
            <div class="theme-option theme-btn-sepia" data-theme="theme-sepia" title="Sepia"></div>
            <div class="theme-option theme-btn-gray" data-theme="theme-gray" title="Gray"></div>
            <div class="theme-option theme-btn-black" data-theme="theme-black" title="Black"></div>
          </div>

          <!-- Fonts -->
          <div class="font-family-list">
            <div class="font-option font-preview-charter" data-font="font-preview-charter">Charter</div>
            <div class="font-option font-preview-athelas" data-font="font-preview-athelas">Athelas</div>
            <div class="font-option font-preview-iowan" data-font="font-preview-iowan">Iowan</div>
            <div class="font-option font-preview-system" data-font="font-preview-system">System Sans</div>
            <div class="font-option font-preview-seravek" data-font="font-preview-seravek">Seravek</div>
          </div>
        </div>
      </div>

      <div class="reader-container">
        <div class="reader-header">
          <h1 class="article-title">${article.title}</h1>
          <div class="article-meta">
            ${article.byline ? `<span>${article.byline}</span> • ` : ''}
            <span>${article.siteName || new URL(window.location.href).hostname}</span>
          </div>
        </div>
        
        ${featuredImage ? `
        <figure class="hero-image" style="margin: 0 0 40px 0; text-align: center;">
          <img src="${featuredImage}" style="max-height: 500px; object-fit: contain; width: 100%; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
        </figure>
        ` : ''}

        <div class="article-content" id="reader-content-body">
          ${article.content}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // Post-process content to add dividers and fix layout
    processContent();

    // Event Listeners
    setupEventListeners();

    // Initial smooth fade in
    overlay.style.opacity = '0';
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
    });
  }

  function processContent() {
    const contentBody = document.getElementById('reader-content-body');
    if (!contentBody) return;

    // 1. Inject Dividers before Headers (H2, H3)
    const headers = contentBody.querySelectorAll('h2');
    headers.forEach((header, index) => {
      // Don't put a divider before the very first element if it's a header
      if (index === 0 && header === contentBody.firstElementChild) return;

      const divider = document.createElement('div');
      divider.className = 'section-divider';
      divider.textContent = '❖'; // Classic divider symbol
      
      header.parentNode.insertBefore(divider, header);
    });

    // 2. Handle HRs ensuring they look good
    const hrs = contentBody.querySelectorAll('hr');
    hrs.forEach(hr => {
      // If HR is already styled by CSS, we might not need to do much, 
      // but we can replace it with our fancy divider if we want uniformity.
      // For now, let CSS handle HR styling.
    });
  }

  function setupEventListeners() {
    // Close
    document.getElementById('reader-close-btn').addEventListener('click', removeOverlay);

    // Toggle Menu
    const appearanceToggle = document.getElementById('appearance-toggle');
    const appearanceMenu = document.getElementById('appearance-menu');

    appearanceToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      appearanceMenu.classList.toggle('open');
      overlay.classList.toggle('controls-visible');
    });

    overlay.addEventListener('click', (e) => {
      if (!appearanceMenu.contains(e.target) && !appearanceToggle.contains(e.target)) {
        appearanceMenu.classList.remove('open');
        overlay.classList.remove('controls-visible');
      }
    });

    // Font Size
    document.getElementById('font-inc').addEventListener('click', () => {
      currentSettings.fontSize = Math.min(32, currentSettings.fontSize + 2);
      overlay.style.setProperty('--font-size', currentSettings.fontSize + 'px');
    });

    document.getElementById('font-dec').addEventListener('click', () => {
      currentSettings.fontSize = Math.max(12, currentSettings.fontSize - 2);
      overlay.style.setProperty('--font-size', currentSettings.fontSize + 'px');
    });

    // Theme Switching
    document.querySelectorAll('.theme-option').forEach(btn => {
      if (btn.dataset.theme === currentSettings.theme) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        overlay.classList.remove('theme-white', 'theme-paper', 'theme-sepia', 'theme-gray', 'theme-black');
        document.querySelectorAll('.theme-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        currentSettings.theme = btn.dataset.theme;
        overlay.classList.add(currentSettings.theme);
      });
    });

    // Font Switching
    document.querySelectorAll('.font-option').forEach(btn => {
       if (btn.dataset.font === currentSettings.font) btn.classList.add('selected');
       btn.addEventListener('click', () => {
         document.querySelectorAll('.font-option').forEach(b => b.classList.remove('selected'));
         btn.classList.add('selected');
         currentSettings.font = btn.dataset.font;
         applyFont(currentSettings.font);
       });
    });

    // Keyboard Shortcuts
    onKeydown = function(e) {
      if (e.key === 'Escape') {
        removeOverlay();
      }
    };
    document.addEventListener('keydown', onKeydown);
  }

  function applyFont(fontClass) {
    let fontFamily = "";
    switch(fontClass) {
      case 'font-preview-charter': fontFamily = '"Charter", "Bitstream Charter", "Sitka Text", serif'; break;
      case 'font-preview-athelas': fontFamily = '"Athelas", "Seravek", "Sitka Text", serif'; break;
      case 'font-preview-iowan': fontFamily = '"Iowan Old Style", "Sitka Text", serif'; break;
      case 'font-preview-seravek': fontFamily = '"Seravek", "Gill Sans Nova", sans-serif'; break;
      case 'font-preview-system': 
      default:
        fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    }
    overlay.style.setProperty('--font-family', fontFamily);
  }

  function removeOverlay() {
    if (onKeydown) {
      document.removeEventListener('keydown', onKeydown);
      onKeydown = null;
    }
    if (overlay) {
      overlay.style.opacity = '0';
      setTimeout(() => {
        if (overlay) overlay.remove();
        overlay = null;
        document.body.style.overflow = '';
        readerActive = false;
      }, 300);
    }
  }
})();
