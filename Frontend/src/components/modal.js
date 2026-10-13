/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - MODAL COMPONENT
 * ================================================================
 * Pure UI Component - Renders a modal dialog.
 * ================================================================
 */

/**
 * Create modal HTML
 * @param {Object} options - Modal configuration
 * @param {string} options.id - Modal ID
 * @param {string} options.title - Modal title
 * @param {string} options.content - Modal body content (HTML)
 * @param {string} options.footer - Modal footer content (HTML)
 * @param {string} options.size - 'sm', 'md', 'lg', 'xl'
 * @param {string} options.icon - Icon class
 * @param {string} options.iconColor - Icon color
 * @param {boolean} options.isOpen - Open state
 * @param {Function} options.onClose - Close callback
 * @param {Function} options.onConfirm - Confirm callback
 * @param {string} options.confirmLabel - Confirm button label
 * @param {string} options.cancelLabel - Cancel button label
 * @param {string} options.confirmVariant - 'primary', 'danger', 'success'
 * @param {boolean} options.showClose - Show close button
 * @param {boolean} options.closeOnOverlay - Close on overlay click
 * @returns {string} Modal HTML
 */
export function createModal(options = {}) {
    const {
        id = 'modal-' + Date.now(),
        title = 'Modal',
        content = '',
        footer = '',
        size = 'md',
        icon = null,
        iconColor = '#2563eb',
        isOpen = false,
        onClose = null,
        onConfirm = null,
        confirmLabel = 'Confirm',
        cancelLabel = 'Cancel',
        confirmVariant = 'primary',
        showClose = true,
       closeOnOverlay = false,
    } = options;

    // ---- Size Classes ----
    const sizeClasses = {
        sm: 'max-width:400px;',
        md: 'max-width:560px;',
        lg: 'max-width:720px;',
        xl: 'max-width:900px;',
    };

    // ---- Variant Colors ----
    const variantColors = {
        primary: 'background:#2563eb; color:white;',
        danger: 'background:#dc2626; color:white;',
        success: 'background:#16a34a; color:white;',
    };

    // ---- Icon ----
    const iconHTML = icon ? `
        <div style="text-align:center; font-size:48px; color:${iconColor}; margin-bottom:12px;">
            <i class="fas ${icon}"></i>
        </div>
    ` : '';

    // ---- Footer Buttons ----
    let footerHTML = footer;
    if (!footer && (onConfirm || onClose)) {
        const confirmBtn = onConfirm ? `
            <button class="modal-confirm-btn" style="padding:10px 24px; border:none; border-radius:8px; font-weight:600; cursor:pointer; transition:all 0.2s; ${variantColors[confirmVariant] || variantColors.primary}">
                ${confirmLabel}
            </button>
        ` : '';
        const cancelBtn = onClose ? `
            <button class="modal-cancel-btn" style="padding:10px 24px; border:2px solid var(--gray-200); border-radius:8px; font-weight:600; background:transparent; color:var(--gray-600); cursor:pointer; transition:all 0.2s;">
                ${cancelLabel}
            </button>
        ` : '';

        footerHTML = `
            <div style="display:flex; justify-content:flex-end; gap:8px;">
                ${cancelBtn}
                ${confirmBtn}
            </div>
        `;
    }

    // ---- Close Button ----
    const closeBtnHTML = showClose ? `
        <button class="modal-close-btn" style="background:none; border:none; font-size:24px; color:var(--gray-400); cursor:pointer; padding:4px; border-radius:50%; transition:background 0.2s, color 0.2s;">
            <i class="fas fa-times"></i>
        </button>
    ` : '';

    // ---- Build Modal ----
    return `
        <div class="modal-overlay ${isOpen ? 'open' : ''}" id="${id}-overlay" style="position:fixed; inset:0; background:rgba(15,23,42,0.5); backdrop-filter:blur(4px); z-index:300; display:flex; align-items:center; justify-content:center; padding:16px; opacity:${isOpen ? 1 : 0}; visibility:${isOpen ? 'visible' : 'hidden'}; transition:all 0.25s ease; ${isOpen ? '' : 'pointer-events:none;'}">
            <div class="modal" style="background:var(--white); border-radius:16px; max-width:90%; width:100%; ${sizeClasses[size] || sizeClasses.md} max-height:90vh; overflow-y:auto; box-shadow:var(--shadow-xl); transform:${isOpen ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(20px)'}; transition:transform 0.25s ease;">

                <!-- Header -->
                <div class="modal-header" style="display:flex; align-items:center; justify-content:space-between; padding:16px 24px; border-bottom:1px solid var(--gray-200);">
                    <h3 style="margin:0; font-size:18px; font-weight:700; color:var(--gray-900);">${title}</h3>
                    ${closeBtnHTML}
                </div>

                <!-- Body -->
                <div class="modal-body" style="padding:24px;">
                    ${iconHTML}
                    <div class="modal-content">${content}</div>
                </div>

                <!-- Footer -->
                <div class="modal-footer" style="padding:16px 24px; border-top:1px solid var(--gray-200); background:var(--gray-50); border-radius:0 0 16px 16px;">
                    ${footerHTML}
                </div>
            </div>
        </div>

        <!-- Modal Styles -->
        <style>
            .modal-overlay.open {
                opacity: 1 !important;
                visibility: visible !important;
                pointer-events: all !important;
            }
            .modal-overlay.open .modal {
                transform: scale(1) translateY(0) !important;
            }
            .modal-close-btn:hover {
                background: var(--gray-100);
                color: var(--gray-600);
            }
            .modal-confirm-btn:hover {
                transform: translateY(-2px);
                box-shadow: var(--shadow-md);
            }
            .modal-cancel-btn:hover {
                background: var(--gray-50);
                border-color: var(--gray-300);
            }
            [data-theme="dark"] .modal-overlay {
                background: rgba(0,0,0,0.7);
            }
            [data-theme="dark"] .modal {
                background: #1e293b;
            }
            [data-theme="dark"] .modal-footer {
                background: #0f172a;
                border-color: #334155;
            }
            [data-theme="dark"] .modal-header {
                border-color: #334155;
            }
        </style>

        <!-- Modal Script -->
        <script>
            (function() {
                const overlay = document.getElementById('${id}-overlay');
                const modal = overlay?.querySelector('.modal');

                // ---- Close on overlay click ----
                ${closeOnOverlay ? 
                    overlay?.addEventListener('click', function(e) {
                        if (e.target === overlay) {
                            ${typeof onClose === 'function' ? onClose.toString() + '()' : 'overlay.classList.remove("open");'};
                        }
                    });
                 : ''}

                // ---- Close button ----
                overlay?.querySelector('.modal-close-btn')?.addEventListener('click', function() {
                    ${typeof onClose === 'function' ? onClose.toString() + '()' : 'overlay.classList.remove("open");'};
                });

                // ---- Cancel button ----
                overlay?.querySelector('.modal-cancel-btn')?.addEventListener('click', function() {
                    ${typeof onClose === 'function' ? onClose.toString() + '()' : 'overlay.classList.remove("open");'};
                });
               // ---- Confirm button ----
                overlay?.querySelector('.modal-confirm-btn')?.addEventListener('click', function() {
                    ${typeof onConfirm === 'function' ? onConfirm.toString() + '()' : ''};
                });

                // ---- Close on Escape ----
                document.addEventListener('keydown', function(e) {
                    if (e.key === 'Escape' && overlay?.classList.contains('open')) {
                        ${typeof onClose === 'function' ? onClose.toString() + '()' : 'overlay.classList.remove("open");'};
                    }
                });
            })();
        </script>
    `;
}

/**
 * Render modal to a container element
 * @param {string|Element} container - Container selector or element
 * @param {Object} options - Same as createModal options
 */
export function renderModal(container, options = {}) {
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!el) {
        console.warn('Modal container not found');
        return;
    }
    el.innerHTML = createModal(options);
}

export default {
    createModal,
    renderModal,
};