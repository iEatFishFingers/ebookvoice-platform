/**
 * Ebook Voice Landing Page - JavaScript
 * Handles theme toggling and smooth interactions
 */

// ===================================
// Theme Management
// ===================================

/**
 * Initialize theme on page load
 */
function initializeTheme() {
    // Check for saved theme preference or default to 'light'
    const savedTheme = localStorage.getItem('theme') || 'light';

    // Apply theme to document
    document.documentElement.setAttribute('data-theme', savedTheme);

    // Update theme toggle button icon
    updateThemeIcon(savedTheme);
}

/**
 * Toggle between light and dark themes
 */
function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';

    // Apply new theme
    document.documentElement.setAttribute('data-theme', newTheme);

    // Save preference to localStorage
    localStorage.setItem('theme', newTheme);

    // Update button icon
    updateThemeIcon(newTheme);

    // Add rotation animation to button
    const themeToggle = document.getElementById('theme-toggle');
    themeToggle.style.transform = 'rotate(360deg)';

    setTimeout(() => {
        themeToggle.style.transform = 'rotate(0deg)';
    }, 300);
}

/**
 * Update theme toggle button icon based on current theme
 * @param {string} theme - Current theme ('light' or 'dark')
 */
function updateThemeIcon(theme) {
    const themeToggle = document.getElementById('theme-toggle');
    const icon = themeToggle.querySelector('i');

    if (theme === 'dark') {
        icon.classList.remove('fa-moon');
        icon.classList.add('fa-sun');
    } else {
        icon.classList.remove('fa-sun');
        icon.classList.add('fa-moon');
    }
}

// ===================================
// Smooth Scrolling
// ===================================

/**
 * Handle smooth scroll for anchor links
 * @param {Event} e - Click event
 */
function handleSmoothScroll(e) {
    const target = e.target.closest('a[href^="#"]');

    if (target && target.getAttribute('href') !== '#') {
        e.preventDefault();

        const targetId = target.getAttribute('href');
        const targetElement = document.querySelector(targetId);

        if (targetElement) {
            const navbarHeight = document.querySelector('.navbar').offsetHeight;
            const targetPosition = targetElement.offsetTop - navbarHeight - 20;

            window.scrollTo({
                top: targetPosition,
                behavior: 'smooth'
            });
        }
    }
}

// ===================================
// Navbar Scroll Effect
// ===================================

/**
 * Add/remove shadow to navbar on scroll
 */
function handleNavbarScroll() {
    const navbar = document.querySelector('.navbar');

    if (window.scrollY > 50) {
        navbar.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.1)';
    } else {
        navbar.style.boxShadow = 'var(--navbar-shadow)';
    }
}

// ===================================
// Scroll Reveal Animation
// ===================================

/**
 * Reveal elements on scroll
 */
function revealOnScroll() {
    const reveals = document.querySelectorAll('.service-card, .pricing-card');

    reveals.forEach(element => {
        const windowHeight = window.innerHeight;
        const elementTop = element.getBoundingClientRect().top;
        const elementVisible = 150;

        if (elementTop < windowHeight - elementVisible) {
            element.style.opacity = '1';
            element.style.transform = 'translateY(0)';
        }
    });
}

/**
 * Initialize scroll reveal styles
 */
function initializeScrollReveal() {
    const reveals = document.querySelectorAll('.service-card, .pricing-card');

    reveals.forEach(element => {
        element.style.opacity = '0';
        element.style.transform = 'translateY(30px)';
        element.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    });
}

// ===================================
// Button Ripple Effect
// ===================================

/**
 * Create ripple effect on button click
 * @param {Event} e - Click event
 */
function createRipple(e) {
    const button = e.currentTarget;

    // Only apply to buttons with btn class
    if (!button.classList.contains('btn')) return;

    const ripple = document.createElement('span');
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;

    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    ripple.classList.add('ripple');

    // Add ripple styles
    ripple.style.position = 'absolute';
    ripple.style.borderRadius = '50%';
    ripple.style.backgroundColor = 'rgba(255, 255, 255, 0.6)';
    ripple.style.transform = 'scale(0)';
    ripple.style.animation = 'ripple-animation 0.6s ease-out';
    ripple.style.pointerEvents = 'none';

    // Ensure button has position relative
    button.style.position = 'relative';
    button.style.overflow = 'hidden';

    button.appendChild(ripple);

    setTimeout(() => {
        ripple.remove();
    }, 600);
}

// ===================================
// Statistics Counter Animation
// ===================================

/**
 * Animate statistics numbers when in view
 */
function animateStats() {
    const stats = document.querySelectorAll('.stat strong');
    let animated = false;

    function checkScroll() {
        if (animated) return;

        const statsSection = document.querySelector('.hero-stats');
        if (!statsSection) return;

        const rect = statsSection.getBoundingClientRect();
        const windowHeight = window.innerHeight;

        if (rect.top < windowHeight && rect.bottom > 0) {
            stats.forEach(stat => {
                const text = stat.textContent;
                const numberMatch = text.match(/[\d,]+/);

                if (numberMatch) {
                    const targetNumber = parseInt(numberMatch[0].replace(/,/g, ''));
                    const suffix = text.replace(numberMatch[0], '');
                    animateNumber(stat, 0, targetNumber, 2000, suffix);
                }
            });

            animated = true;
        }
    }

    window.addEventListener('scroll', checkScroll);
    checkScroll(); // Check on load
}

/**
 * Animate a number from start to end
 * @param {HTMLElement} element - Element to animate
 * @param {number} start - Start number
 * @param {number} end - End number
 * @param {number} duration - Animation duration in ms
 * @param {string} suffix - Suffix to append
 */
function animateNumber(element, start, end, duration, suffix = '') {
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Easing function for smooth animation
        const easeOutQuart = 1 - Math.pow(1 - progress, 4);
        const current = Math.floor(start + (end - start) * easeOutQuart);

        element.textContent = current.toLocaleString() + suffix;

        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }

    requestAnimationFrame(update);
}

// ===================================
// Event Listeners
// ===================================

/**
 * Initialize all event listeners
 */
function initializeEventListeners() {
    // Theme toggle
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }

    // Smooth scrolling for all anchor links
    document.addEventListener('click', handleSmoothScroll);

    // Navbar scroll effect
    window.addEventListener('scroll', handleNavbarScroll);

    // Scroll reveal
    window.addEventListener('scroll', revealOnScroll);

    // Button ripple effect
    const buttons = document.querySelectorAll('.btn');
    buttons.forEach(button => {
        button.addEventListener('click', createRipple);
    });
}

// ===================================
// CSS Animation Keyframes
// ===================================

/**
 * Add ripple animation keyframes to document
 */
function addAnimationStyles() {
    const style = document.createElement('style');
    style.textContent = `
        @keyframes ripple-animation {
            to {
                transform: scale(4);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);
}

// ===================================
// Handle page visibility changes
// ===================================

/**
 * Pause/resume animations when page visibility changes
 */
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Page hidden — polling continues via setTimeout, no action needed
    } else {
        // Page became visible — re-check if we missed a completion while hidden
        if (!document.getElementById('conversionPill')) {
            recoverActiveConversion();
        }
    }
});

// ===================================
// DASHBOARD-SPECIFIC FUNCTIONALITY
// ===================================

/**
 * Detect if we're on the dashboard page
 */
function isDashboardPage() {
    return window.location.pathname.includes('dashboard.html') ||
           document.querySelector('.dashboard-main') !== null;
}

/**
 * Initialize dashboard-specific features
 */
async function initializeDashboard() {
    if (!isDashboardPage()) return;

    // Auth guard
    if (typeof requireAuth === 'function') {
        const authed = await requireAuth();
        if (!authed) return;
    }

    // Animate dashboard stats on load
    animateDashboardStats();

    // Initialize audiobook play buttons
    initializePlayButtons();

    // Initialize filter functionality
    initializeFilters();

    // Initialize progress animations
    animateProgressBars();

    // Initialize user profile dropdown (placeholder)
    initializeUserProfile();

    // Load real data from API
    loadDashboardData();
}

/**
 * Load real dashboard data from API
 */
async function loadDashboardData() {
    // Load profile data for welcome section and stats
    try {
        const profile = await EbookVoiceAPI.getProfile();

        // Update welcome name
        const welcomeTitle = document.querySelector('.welcome-title');
        if (welcomeTitle) {
            const firstName = profile.firstName || profile.displayName || 'there';
            welcomeTitle.innerHTML = `Welcome back, <span class="gradient-text">${firstName}</span>!`;
        }

        // Update stat cards
        const statNumbers = document.querySelectorAll('.stat-info h3');
        if (statNumbers.length >= 4) {
            statNumbers[0].textContent = profile.audiobookCount || 0;
            // statNumbers[1] = "Books in Progress" — no API for this yet, leave placeholder
            // statNumbers[2] = "Words This Month"  — no API for this yet, leave placeholder
            statNumbers[3].textContent = '0h 0m';
        }

        // Update subscription widget
        const planBadge = document.querySelector('.plan-badge');
        if (planBadge) {
            const plan = (profile.plan || 'free').toLowerCase();
            planBadge.textContent = plan.charAt(0).toUpperCase() + plan.slice(1);
            planBadge.className = `plan-badge ${plan}`;
        }
        const planName = document.querySelector('.plan-name');
        if (planName) {
            const plan = (profile.plan || 'free').toLowerCase();
            const planNames = { free: 'Free Plan', starter: 'Starter Plan', pro: 'Professional Plan', enterprise: 'Enterprise Plan' };
            planName.textContent = planNames[plan] || 'Free Plan';
        }
        const planPrice = document.querySelector('.plan-price');
        if (planPrice) {
            const plan = (profile.plan || 'free').toLowerCase();
            const prices = { free: '£0', starter: '£9.99', pro: '£19.99', enterprise: 'Custom' };
            planPrice.innerHTML = `${prices[plan] || '£0'}<span>/month</span>`;
        }

        // Update usage stats
        const usageValues = document.querySelectorAll('.usage-value');
        if (usageValues.length >= 1) {
            usageValues[0].textContent = `${profile.monthlyConversionCount || 0} / ${profile.maxMonthlyConversions || 1}`;
        }
        const usageFills = document.querySelectorAll('.usage-fill');
        if (usageFills.length >= 1 && profile.maxMonthlyConversions) {
            const pct = Math.min(100, ((profile.monthlyConversionCount || 0) / profile.maxMonthlyConversions) * 100);
            usageFills[0].style.width = `${pct}%`;
        }
    } catch (err) {
        console.error('Error loading profile:', err);
    }

    // Load audiobook library
    try {
        const audiobooks = await EbookVoiceAPI.getLibrary();
        const libraryGrid = document.querySelector('.library-grid');
        if (!libraryGrid) return;

        if (!audiobooks || audiobooks.length === 0) {
            libraryGrid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; text-align: center; padding: 40px;">
                    <div class="empty-icon" style="font-size: 3rem; color: var(--text-secondary); margin-bottom: 16px;">
                        <i class="fas fa-headphones"></i>
                    </div>
                    <h3>No audiobooks yet</h3>
                    <p style="color: var(--text-secondary); margin-bottom: 16px;">Convert your first ebook to get started!</p>
                    <a href="create.html" class="btn btn-primary">
                        <i class="fas fa-plus"></i> Create Audiobook
                    </a>
                </div>
            `;
            return;
        }

        libraryGrid.innerHTML = audiobooks.map(book => {
            const coverUrl = book.coverUrl || book.cover_url || 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=300&h=400&fit=crop';
            const title = book.title || 'Untitled';
            const duration = book.totalDuration || book.total_duration || '';
            const createdAt = book.createdAt || book.created_at || '';
            const dateStr = createdAt ? new Date(createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

            return `
                <div class="audiobook-card" data-audiobook-id="${book.id}">
                    <div class="book-cover">
                        <img src="${coverUrl}" alt="${title}">
                        <a href="player.html?id=${book.id}" class="play-overlay">
                            <button class="play-btn">
                                <i class="fas fa-play"></i>
                            </button>
                        </a>
                    </div>
                    <div class="book-info">
                        <h3>${title}</h3>
                        <p class="book-meta">
                            ${duration ? `<i class="fas fa-clock"></i> ${duration}` : ''}
                            ${duration && dateStr ? '<span class="divider">&bull;</span>' : ''}
                            ${dateStr ? `<i class="fas fa-calendar"></i> ${dateStr}` : ''}
                        </p>
                        <div class="book-actions">
                            <button class="btn-icon delete-audiobook-btn" title="Delete" data-id="${book.id}">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // Wire delete buttons
        libraryGrid.querySelectorAll('.delete-audiobook-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = btn.dataset.id;
                if (!confirm('Delete this audiobook? This cannot be undone.')) return;
                try {
                    await EbookVoiceAPI.deleteAudiobook(id);
                    btn.closest('.audiobook-card').remove();
                    showNotification('Audiobook deleted');
                    // Check if grid is now empty
                    if (libraryGrid.querySelectorAll('.audiobook-card').length === 0) {
                        loadDashboardData();
                    }
                } catch (err) {
                    showNotification('Failed to delete audiobook');
                    console.error(err);
                }
            });
        });

        // Re-initialize play buttons after dynamic render
        initializePlayButtons();

    } catch (err) {
        console.error('Error loading library:', err);
    }
}

/**
 * Animate dashboard statistics cards
 */
function animateDashboardStats() {
    const statCards = document.querySelectorAll('.stat-card');

    statCards.forEach((card, index) => {
        // Add initial hidden state
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';

        // Animate in with stagger
        setTimeout(() => {
            card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, index * 100);
    });

    // Animate stat numbers
    const statNumbers = document.querySelectorAll('.stat-info h3');

    setTimeout(() => {
        statNumbers.forEach(stat => {
            const text = stat.textContent.trim();

            // Check if it's a number
            const numberMatch = text.match(/^([\d,]+)/);
            if (numberMatch) {
                const targetNumber = parseInt(numberMatch[0].replace(/,/g, ''));
                const suffix = text.replace(numberMatch[0], '').trim();
                animateNumber(stat, 0, targetNumber, 1500, suffix ? ' ' + suffix : '');
            }
        });
    }, 400);
}

/**
 * Initialize audiobook play button functionality
 */
function initializePlayButtons() {
    const playButtons = document.querySelectorAll('.play-btn');

    playButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            e.stopPropagation();

            const icon = button.querySelector('i');
            const isPlaying = icon.classList.contains('fa-pause');

            if (isPlaying) {
                icon.classList.remove('fa-pause');
                icon.classList.add('fa-play');
                button.setAttribute('aria-label', 'Play audiobook');
            } else {
                // Pause all other playing audiobooks
                document.querySelectorAll('.play-btn i.fa-pause').forEach(otherIcon => {
                    otherIcon.classList.remove('fa-pause');
                    otherIcon.classList.add('fa-play');
                });

                icon.classList.remove('fa-play');
                icon.classList.add('fa-pause');
                button.setAttribute('aria-label', 'Pause audiobook');
            }

            // Add pulse animation
            button.style.animation = 'pulse 0.3s ease';
            setTimeout(() => {
                button.style.animation = '';
            }, 300);
        });
    });
}

/**
 * Initialize filter/sort functionality
 */
function initializeFilters() {
    const filterSelect = document.querySelector('.filter-select');

    if (filterSelect) {
        filterSelect.addEventListener('change', (e) => {
            const selectedOption = e.target.value;
            console.log(`Filtering by: ${selectedOption}`);

            // Add visual feedback
            filterSelect.style.transform = 'scale(0.95)';
            setTimeout(() => {
                filterSelect.style.transform = 'scale(1)';
            }, 150);

            // In a real app, this would trigger actual filtering
            // For now, we'll just show a notification
            showNotification(`Sorting by: ${selectedOption}`);
        });
    }
}

/**
 * Animate progress bars on load
 */
function animateProgressBars() {
    const progressBars = document.querySelectorAll('.progress-fill, .usage-fill');

    progressBars.forEach((bar, index) => {
        const targetWidth = bar.style.width;
        bar.style.width = '0%';

        setTimeout(() => {
            bar.style.transition = 'width 1s ease-out';
            bar.style.width = targetWidth;
        }, 500 + (index * 200));
    });

    // Add shimmer animation to progress bars inside actively-converting cards
    document.querySelectorAll('.progress-card').forEach(card => {
        if (card.querySelector('.status-badge.converting')) {
            const fill = card.querySelector('.progress-fill');
            if (fill) fill.classList.add('live');
        }
    });
}

/**
 * Initialize user profile dropdown
 */
function initializeUserProfile() {
    const userProfile = document.querySelector('.user-profile');

    if (userProfile) {
        userProfile.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log('User profile clicked - dropdown would appear here');

            // Add subtle scale animation
            userProfile.style.transform = 'scale(0.95)';
            setTimeout(() => {
                userProfile.style.transform = 'scale(1)';
            }, 150);
        });
    }
}

/**
 * Show a temporary notification (simple version)
 */
function showNotification(message) {
    // Check if notification already exists
    let notification = document.querySelector('.notification-toast');

    if (!notification) {
        notification = document.createElement('div');
        notification.className = 'notification-toast';
        document.body.appendChild(notification);

        // Add styles
        notification.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            background: var(--gradient);
            color: white;
            padding: 16px 24px;
            border-radius: 12px;
            box-shadow: var(--shadow-lg);
            font-weight: 600;
            z-index: 10000;
            transform: translateY(100px);
            opacity: 0;
            transition: all 0.3s ease;
        `;
    }

    notification.textContent = message;

    // Animate in
    setTimeout(() => {
        notification.style.transform = 'translateY(0)';
        notification.style.opacity = '1';
    }, 10);

    // Animate out after 3 seconds
    setTimeout(() => {
        notification.style.transform = 'translateY(100px)';
        notification.style.opacity = '0';

        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

// ===================================
// CONVERSION MODAL
// ===================================

/**
 * Show the animated conversion modal.
 * Returns a controller to update/complete/fail the modal.
 *
 * @param {string} title - Book title shown in modal header
 * @returns {{ update, succeed, fail, onBackground, close }}
 */
function showConversionModal(title) {
    // Remove any existing conversion modal
    const existing = document.getElementById('conversionModal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'conversionModal';
    overlay.className = 'conversion-modal-overlay';

    overlay.innerHTML = `
        <div class="conversion-modal-panel" id="conversionModalPanel">
            <div class="conversion-modal-body">
                <div class="waveform">
                    <div class="waveform-bar"></div>
                    <div class="waveform-bar"></div>
                    <div class="waveform-bar"></div>
                    <div class="waveform-bar"></div>
                    <div class="waveform-bar"></div>
                    <div class="waveform-bar"></div>
                    <div class="waveform-bar"></div>
                    <div class="waveform-bar"></div>
                    <div class="waveform-bar"></div>
                </div>
                <div class="conversion-modal-title">${title || 'Converting your book'}</div>
                <div class="conversion-modal-subtitle" id="convModalStep">Preparing...</div>
                <div class="conversion-progress-wrap">
                    <div class="conversion-progress-track">
                        <div class="conversion-progress-fill" id="convModalFill" style="width:5%;"></div>
                    </div>
                    <div class="conversion-progress-row">
                        <span id="convModalStatus">Processing</span>
                        <span class="conversion-percent" id="convModalPct">5%</span>
                    </div>
                </div>
                <div class="conversion-modal-actions">
                    <button class="conversion-bg-btn" id="convModalBgBtn">
                        <i class="fas fa-arrow-down"></i> Send to background
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Step label mapping based on progress %
    function stepLabel(pct) {
        if (pct < 15)  return 'Preparing audio pipeline...';
        if (pct < 40)  return 'Processing text...';
        if (pct < 65)  return 'Generating voice audio...';
        if (pct < 85)  return 'Stitching chapters...';
        if (pct < 98)  return 'Finalizing...';
        return 'Almost done...';
    }

    const fillEl   = document.getElementById('convModalFill');
    const pctEl    = document.getElementById('convModalPct');
    const stepEl   = document.getElementById('convModalStep');
    const statusEl = document.getElementById('convModalStatus');
    const panel    = document.getElementById('conversionModalPanel');
    const bgBtn    = document.getElementById('convModalBgBtn');

    let _onBackground = null;
    let _removed = false;

    bgBtn.addEventListener('click', () => {
        if (_onBackground) _onBackground();
    });

    return {
        /** Update progress. pct = 0-100, stepText optional override */
        update(pct, stepText) {
            if (_removed) return;
            const p = Math.min(Math.max(pct || 0, 5), 99);
            fillEl.style.width = p + '%';
            pctEl.textContent  = p + '%';
            stepEl.textContent = stepText || stepLabel(p);
            statusEl.textContent = 'Converting';
        },

        /** Call when conversion is complete */
        succeed() {
            if (_removed) return;
            panel.classList.add('success');
            fillEl.style.width = '100%';
            pctEl.textContent  = '100%';
            stepEl.textContent = 'Conversion complete!';
            statusEl.textContent = 'Done';
            bgBtn.style.display = 'none';

            // Auto-close after 1.5s
            setTimeout(() => {
                _removed = true;
                overlay.remove();
            }, 1500);
        },

        /** Call on error */
        fail(msg) {
            panel.classList.add('error');
            stepEl.textContent = msg || 'Conversion failed. Please try again.';
            statusEl.textContent = 'Error';
            bgBtn.textContent = 'Close';
            bgBtn.onclick = () => overlay.remove();
        },

        /** Register background callback — called when user clicks "Send to background" */
        onBackground(cb) { _onBackground = cb; },

        /** Programmatically close */
        close() { _removed = true; overlay.remove(); },
    };
}

// ===================================
// NAVBAR CONVERSION PILL
// ===================================

/**
 * Inject the conversion status pill into the navbar.
 * Safe to call on any page — finds .nav-links and inserts before #theme-toggle.
 * Returns a controller to drive pill state.
 *
 * @param {string} title - Book title
 * @returns {{ update, complete, fail, remove }}
 */
function activateConversionPill(title) {
    // Remove existing pill if any
    const existing = document.getElementById('conversionPill');
    if (existing) existing.remove();

    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) return { update(){}, complete(){}, fail(){}, remove(){} };

    const pill = document.createElement('div');
    pill.id = 'conversionPill';
    pill.className = 'conversion-pill';
    pill.setAttribute('role', 'status');
    pill.innerHTML = `
        <span class="pill-dot active" id="pillDot"></span>
        <span id="pillLabel">Converting \xb7 0%</span>
        <div class="pill-popover" id="pillPopover">
            <div class="pill-popover-title" id="pillPopTitle">${title || 'Converting...'}</div>
            <div class="pill-popover-track">
                <div class="pill-popover-fill" id="pillPopFill" style="width:0%;"></div>
            </div>
            <div class="pill-popover-pct" id="pillPopPct">0%</div>
        </div>
    `;

    // Insert before #theme-toggle
    const themeToggle = navLinks.querySelector('#theme-toggle');
    if (themeToggle) {
        navLinks.insertBefore(pill, themeToggle);
    } else {
        navLinks.appendChild(pill);
    }

    const dot      = document.getElementById('pillDot');
    const label    = document.getElementById('pillLabel');
    const popover  = document.getElementById('pillPopover');
    const popFill  = document.getElementById('pillPopFill');
    const popPct   = document.getElementById('pillPopPct');

    // Toggle popover on click (when active)
    pill.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dot.classList.contains('active')) {
            popover.classList.toggle('visible');
        }
    });

    // Close popover on outside click
    function closePillPopover(e) {
        if (!pill.contains(e.target)) {
            popover.classList.remove('visible');
        }
    }
    document.addEventListener('click', closePillPopover);

    return {
        update(pct) {
            const p = Math.min(Math.max(pct || 0, 0), 99);
            label.textContent   = `Converting \xb7 ${p}%`;
            popFill.style.width = p + '%';
            popPct.textContent  = p + '%';
        },

        complete(bookTitle) {
            dot.className = 'pill-dot complete';
            const shortTitle = (bookTitle || title || 'Your book').substring(0, 22);
            label.textContent = `Ready \xb7 ${shortTitle}`;
            popover.classList.remove('visible');
            pill.onclick = () => { window.location.href = 'player.html'; };
        },

        fail() {
            dot.className = 'pill-dot error';
            label.textContent = 'Conversion failed';
            popover.classList.remove('visible');
            pill.onclick = () => {
                showNotification('Conversion failed. Please try again from the editor.');
            };
        },

        remove() {
            document.removeEventListener('click', closePillPopover);
            pill.remove();
        },
    };
}

// ===================================
// CONVERSION RECOVERY (on page load)
// ===================================

let _recoveryInProgress = false;

/**
 * Check localStorage for an active conversion task.
 * Called on every page load and on visibility change.
 *   - Still processing → show navbar pill, resume polling
 *   - Complete → show "Your book is ready" toast with link
 *   - Failed / stale (>2hrs) → clear silently
 */
async function recoverActiveConversion() {
    // Skip if already recovering or pill is already active
    if (_recoveryInProgress || document.getElementById('conversionPill')) return;
    _recoveryInProgress = true;

    try {
        let stored;
        try {
            stored = JSON.parse(localStorage.getItem('activeConversion') || 'null');
        } catch {
            localStorage.removeItem('activeConversion');
            return;
        }

        if (!stored || !stored.taskId) return;

        // Clear if older than 2 hours
        const TWO_HOURS = 2 * 60 * 60 * 1000;
        if (Date.now() - stored.startedAt > TWO_HOURS) {
            localStorage.removeItem('activeConversion');
            return;
        }

        // Need the API to be available
        if (typeof EbookVoiceAPI === 'undefined') return;

        // Check current status once
        let status;
        try {
            status = await EbookVoiceAPI.getConversionStatus(stored.taskId);
        } catch {
            // API unreachable — leave in localStorage, try again next load
            return;
        }

        if (status.complete) {
            localStorage.removeItem('activeConversion');
            showReadyToast(stored.title);
            return;
        }

        if (status.error) {
            localStorage.removeItem('activeConversion');
            return;
        }

        // Still in progress — activate pill and resume polling
        const pill = activateConversionPill(stored.title);
        pill.update(status.progress || 0);

        try {
            await EbookVoiceAPI.pollConversionStatus(stored.taskId, (s) => {
                pill.update(s.progress || 0);
            });
            localStorage.removeItem('activeConversion');
            pill.complete(stored.title);
        } catch {
            localStorage.removeItem('activeConversion');
            pill.fail();
        }
    } finally {
        _recoveryInProgress = false;
    }
}

// ===================================
// UPGRADE MODAL (monetization gate)
// ===================================

/**
 * Show the "Conversion Limit Reached" upgrade modal.
 * Fires when the backend returns conversion_limit_reached: true (HTTP 403).
 * Calls Stripe checkout for the 'starter' tier on CTA click.
 */
function showUpgradeModal() {
    const existing = document.getElementById('upgradeModal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'upgradeModal';
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:10001',
        'background:rgba(0,0,0,0.6)', 'backdrop-filter:blur(4px)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'padding:20px',
    ].join(';');

    overlay.innerHTML = `
        <div style="
            background:var(--bg-primary,#fff);
            border-radius:20px;
            box-shadow:0 24px 64px rgba(0,0,0,0.25);
            padding:40px 36px;
            max-width:460px;
            width:100%;
            text-align:center;
            position:relative;
        ">
            <button id="closeUpgradeModal" style="
                position:absolute; top:16px; right:16px;
                background:none; border:none; font-size:1.4rem;
                cursor:pointer; color:var(--text-secondary,#666);
            ">&#x2715;</button>

            <div style="font-size:3rem; margin-bottom:16px;">🚀</div>

            <h2 style="
                font-family:'Poppins',sans-serif; font-size:1.5rem;
                font-weight:700; color:var(--text-primary,#111);
                margin:0 0 8px;
            ">Monthly Limit Reached</h2>

            <p style="
                color:var(--text-secondary,#666); font-size:0.95rem;
                line-height:1.6; margin:0 0 24px;
            ">
                You've used your <strong>2 free conversions</strong> this month.
                Upgrade to <strong>Starter</strong> for 20 conversions/month, more voices,
                and higher-quality audio — starting at just <strong>£9.99/month</strong>.
            </p>

            <div style="
                background:linear-gradient(135deg,#6366f1,#8b5cf6);
                border-radius:14px; padding:20px; margin-bottom:20px; color:#fff;
            ">
                <div style="font-weight:700; font-size:1.1rem; margin-bottom:4px;">Starter Plan — £9.99/month</div>
                <div style="font-size:0.85rem; opacity:0.9;">20 conversions · 50 audiobooks · High-quality audio</div>
            </div>

            <button id="upgradeToStarterBtn" style="
                width:100%; padding:16px; border:none; border-radius:12px;
                background:linear-gradient(135deg,#6366f1,#8b5cf6);
                color:#fff; font-size:1rem; font-weight:700;
                cursor:pointer; font-family:inherit; margin-bottom:10px;
                transition:opacity 0.2s;
            ">⚡ Upgrade to Starter</button>

            <button id="dismissUpgradeBtn" style="
                width:100%; padding:12px; border:1px solid var(--border-color,#e5e7eb);
                border-radius:12px; background:none; color:var(--text-secondary,#666);
                font-size:0.9rem; cursor:pointer; font-family:inherit;
            ">Maybe Later</button>
        </div>
    `;

    document.body.appendChild(overlay);

    // Close handlers
    const close = () => overlay.remove();
    document.getElementById('closeUpgradeModal').addEventListener('click', close);
    document.getElementById('dismissUpgradeBtn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // Stripe checkout
    document.getElementById('upgradeToStarterBtn').addEventListener('click', async () => {
        const btn = document.getElementById('upgradeToStarterBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
        try {
            if (typeof EbookVoiceAPI === 'undefined') throw new Error('API not available');
            const result = await EbookVoiceAPI.createCheckoutSession('starter');
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                throw new Error('No checkout URL returned');
            }
        } catch (err) {
            if (btn) { btn.disabled = false; btn.textContent = '⚡ Upgrade to Starter'; }
            showNotification('Could not start checkout. Please try from Settings → Subscription.');
            console.error('Checkout error:', err);
        }
    });
}

/**
 * Show a persistent "book ready" toast with a Listen Now button.
 * Auto-dismisses after 12 seconds.
 */
function showReadyToast(title) {
    const existing = document.getElementById('readyToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'readyToast';
    toast.style.cssText = [
        'position:fixed',
        'bottom:24px',
        'right:24px',
        'background:var(--bg-primary)',
        'border:1px solid var(--border-color)',
        'border-left:4px solid #10b981',
        'color:var(--text-primary)',
        'padding:16px 20px',
        'border-radius:14px',
        'box-shadow:var(--shadow-lg)',
        'z-index:10000',
        'display:flex',
        'flex-direction:column',
        'gap:10px',
        'min-width:260px',
        'max-width:320px',
        'opacity:0',
        'transform:translateY(20px) scale(0.97)',
        'transition:opacity 0.35s cubic-bezier(0.34,1.56,0.64,1),transform 0.35s cubic-bezier(0.34,1.56,0.64,1)',
    ].join(';');

    const safeTitle = (title || 'Your book').replace(/</g, '&lt;').replace(/>/g, '&gt;').substring(0, 30);
    toast.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
            <i class="fas fa-check-circle" style="color:#10b981;font-size:18px;flex-shrink:0;"></i>
            <div>
                <div style="font-weight:700;font-size:14px;">${safeTitle} is ready!</div>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">Your audiobook has been created.</div>
            </div>
        </div>
        <div style="display:flex;gap:8px;">
            <a href="player.html" style="flex:1;text-align:center;padding:8px 0;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Listen Now</a>
            <button id="readyToastDismiss" style="padding:8px 14px;background:var(--bg-tertiary);border:none;border-radius:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);">Dismiss</button>
        </div>
    `;

    document.body.appendChild(toast);

    // Animate in (double rAF to ensure paint before transition)
    requestAnimationFrame(() => requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0) scale(1)';
    }));

    function dismissToast() {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px) scale(0.97)';
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 380);
    }

    document.getElementById('readyToastDismiss').addEventListener('click', dismissToast);

    // Auto-dismiss after 12 seconds
    setTimeout(dismissToast, 12000);
}

/**
 * Add pulse animation keyframes
 */
function addDashboardAnimations() {
    const style = document.createElement('style');
    style.textContent = `
        @keyframes pulse {
            0%, 100% {
                transform: scale(1);
            }
            50% {
                transform: scale(1.05);
            }
        }
    `;
    document.head.appendChild(style);
}

// ===================================
// AUDIO PLAYER FUNCTIONALITY
// ===================================

/**
 * Detect if we're on the player page
 */
function isPlayerPage() {
    return window.location.pathname.includes('player.html') ||
           document.querySelector('.player-main') !== null;
}

/**
 * Initialize audio player
 */
async function initializeAudioPlayer() {
    if (!isPlayerPage()) return;

    // Auth guard
    if (typeof requireAuth === 'function') {
        const authed = await requireAuth();
        if (!authed) return;
    }

    const audio = document.getElementById('audioElement');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const prevChapterBtn = document.getElementById('prevChapterBtn');
    const nextChapterBtn = document.getElementById('nextChapterBtn');
    const rewindBtn = document.getElementById('rewindBtn');
    const forwardBtn = document.getElementById('forwardBtn');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const progressHandle = document.getElementById('progressHandle');
    const currentTimeEl = document.getElementById('currentTime');
    const totalTimeEl = document.getElementById('totalTime');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeBtn = document.getElementById('volumeBtn');
    const speedBtn = document.getElementById('speedBtn');
    const speedMenu = document.getElementById('speedMenu');
    const speedOptions = document.querySelectorAll('.speed-option');
    const bookmarkBtn = document.getElementById('bookmarkBtn');
    const shareBtn = document.getElementById('shareBtn');
    const toggleTextBtn = document.getElementById('toggleTextBtn');
    const readAlongContent = document.getElementById('readAlongContent');
    const mobileChapterToggle = document.getElementById('mobileChapterToggle');
    const chaptersSidebar = document.querySelector('.chapters-sidebar');

    let currentChapterIndex = 0;
    let isPlaying = false;
    let currentSpeed = 1;
    let audiobookData = null;
    let chaptersData = [];
    let progressSaveTimer = null;

    // Load audiobook by ID from URL
    const audiobookId = new URLSearchParams(window.location.search).get('id');

    if (audiobookId && typeof EbookVoiceAPI !== 'undefined') {
        try {
            const audiobooks = await EbookVoiceAPI.getLibrary();
            audiobookData = audiobooks.find(b => b.id === audiobookId || b.id === parseInt(audiobookId));

            if (audiobookData) {
                // Update book metadata
                const bookTitle = document.querySelector('.book-title');
                const bookAuthor = document.querySelector('.book-author');
                const bookCoverImg = document.querySelector('.book-cover-large img');

                if (bookTitle) bookTitle.textContent = audiobookData.title || 'Untitled';
                if (bookAuthor) bookAuthor.textContent = audiobookData.author ? `By ${audiobookData.author}` : '';
                if (bookCoverImg && (audiobookData.coverUrl || audiobookData.cover_url)) {
                    bookCoverImg.src = audiobookData.coverUrl || audiobookData.cover_url;
                }

                // Build chapters array from audiobook data
                chaptersData = audiobookData.chapters || [];

                if (chaptersData.length > 0) {
                    // Rebuild chapter sidebar
                    const chaptersList = document.querySelector('.chapters-list');
                    const chaptersCount = document.querySelector('.chapters-count');
                    if (chaptersCount) chaptersCount.textContent = `${chaptersData.length} chapters`;

                    if (chaptersList) {
                        chaptersList.innerHTML = chaptersData.map((ch, i) => `
                            <div class="chapter-item ${i === 0 ? 'active' : ''}" data-chapter="${i + 1}">
                                <div class="chapter-thumbnail">
                                    <i class="fas fa-book-open"></i>
                                </div>
                                <div class="chapter-details">
                                    <span class="chapter-number">Chapter ${i + 1}</span>
                                    <h4 class="chapter-title">${ch.title || `Chapter ${i + 1}`}</h4>
                                    <span class="chapter-duration">${ch.duration || ''}</span>
                                </div>
                                ${i === 0 ? '<div class="chapter-playing"><i class="fas fa-volume-up"></i></div>' : ''}
                            </div>
                        `).join('');
                    }

                    // Set audio source to first chapter
                    const firstAudioUrl = chaptersData[0].audioUrl || chaptersData[0].audio_url;
                    if (firstAudioUrl && audio) {
                        audio.src = firstAudioUrl;
                        audio.load();
                    }
                }

                // Update total duration display
                const bookDuration = document.querySelector('.book-duration');
                if (bookDuration && audiobookData.totalDuration) {
                    bookDuration.innerHTML = `<i class="fas fa-clock"></i> Total: ${audiobookData.totalDuration}`;
                }

                // Restore saved position
                if (audiobookData.currentChapter != null) {
                    currentChapterIndex = audiobookData.currentChapter;
                }
            }
        } catch (err) {
            console.error('Error loading audiobook:', err);
        }
    }

    // Re-query chapter items after dynamic render
    let chapterItems = document.querySelectorAll('.chapter-item');

    /**
     * Format time in MM:SS format
     */
    function formatTime(seconds) {
        if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Toggle play/pause — uses real <audio> element
     */
    function togglePlayPause() {
        const icon = playPauseBtn.querySelector('i');

        if (isPlaying) {
            audio.pause();
            isPlaying = false;
            icon.classList.remove('fa-pause');
            icon.classList.add('fa-play');
            playPauseBtn.setAttribute('title', 'Play');
        } else {
            audio.play().catch(err => console.error('Playback error:', err));
            isPlaying = true;
            icon.classList.remove('fa-play');
            icon.classList.add('fa-pause');
            playPauseBtn.setAttribute('title', 'Pause');
        }
    }

    // Real audio event: timeupdate
    if (audio) {
        audio.addEventListener('timeupdate', () => {
            if (!audio.duration) return;
            const progress = (audio.currentTime / audio.duration) * 100;
            progressFill.style.width = `${progress}%`;
            progressHandle.style.left = `${progress}%`;
            currentTimeEl.textContent = formatTime(audio.currentTime);
        });

        audio.addEventListener('loadedmetadata', () => {
            totalTimeEl.textContent = formatTime(audio.duration);
        });

        audio.addEventListener('ended', () => {
            // Auto-play next chapter
            if (currentChapterIndex < chaptersData.length - 1) {
                switchToChapter(currentChapterIndex + 1);
                audio.play().catch(() => {});
            } else {
                isPlaying = false;
                const icon = playPauseBtn.querySelector('i');
                icon.classList.remove('fa-pause');
                icon.classList.add('fa-play');
            }
        });
    }

    /**
     * Seek to position
     */
    function seekTo(event) {
        const rect = progressBar.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        if (audio && audio.duration) {
            audio.currentTime = percent * audio.duration;
        }
    }

    /**
     * Rewind 15 seconds
     */
    function rewind() {
        if (audio) audio.currentTime = Math.max(0, audio.currentTime - 15);
    }

    /**
     * Forward 15 seconds
     */
    function forward() {
        if (audio && audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 15);
    }

    /**
     * Switch to chapter by index
     */
    function switchToChapter(chapterIdx) {
        currentChapterIndex = chapterIdx;

        // Update chapter UI
        chapterItems = document.querySelectorAll('.chapter-item');
        chapterItems.forEach(item => {
            item.classList.remove('active');
            const playingIcon = item.querySelector('.chapter-playing');
            if (playingIcon) playingIcon.remove();
            if (parseInt(item.dataset.chapter) === chapterIdx + 1) {
                item.classList.add('active');
                item.insertAdjacentHTML('beforeend', '<div class="chapter-playing"><i class="fas fa-volume-up"></i></div>');
            }
        });

        // Load audio for this chapter
        if (chaptersData[chapterIdx]) {
            const audioUrl = chaptersData[chapterIdx].audioUrl || chaptersData[chapterIdx].audio_url;
            if (audioUrl && audio) {
                audio.src = audioUrl;
                audio.load();
                if (isPlaying) {
                    audio.play().catch(() => {});
                }
            }
        }

        // Reset progress display
        currentTimeEl.textContent = '0:00';
        progressFill.style.width = '0%';
        progressHandle.style.left = '0%';

        // Show notification
        const titleEl = document.querySelector(`.chapter-item[data-chapter="${chapterIdx + 1}"] .chapter-title`);
        if (titleEl) showNotification(`Now playing: ${titleEl.textContent}`);

        // Save position
        savePlaybackPosition();
    }

    function switchToPrevChapter() {
        if (currentChapterIndex > 0) switchToChapter(currentChapterIndex - 1);
    }

    function switchToNextChapter() {
        if (currentChapterIndex < chaptersData.length - 1) switchToChapter(currentChapterIndex + 1);
    }

    /**
     * Update volume — real audio
     */
    function updateVolume() {
        const volume = volumeSlider.value / 100;
        if (audio) audio.volume = volume;

        const icon = volumeBtn.querySelector('i');
        if (volume === 0) {
            icon.className = 'fas fa-volume-mute';
        } else if (volume < 0.5) {
            icon.className = 'fas fa-volume-down';
        } else {
            icon.className = 'fas fa-volume-up';
        }
    }

    function toggleSpeedMenu() {
        speedMenu.classList.toggle('active');
    }

    function setPlaybackSpeed(speed) {
        currentSpeed = speed;
        if (audio) audio.playbackRate = speed;

        speedOptions.forEach(option => {
            option.classList.remove('active');
            if (parseFloat(option.dataset.speed) === speed) option.classList.add('active');
        });

        speedBtn.querySelector('.speed-value').textContent = `${speed}x`;
        speedMenu.classList.remove('active');
    }

    function toggleBookmark() {
        const icon = bookmarkBtn.querySelector('i');
        if (icon.classList.contains('far')) {
            icon.classList.remove('far');
            icon.classList.add('fas');
            showNotification('Position bookmarked!');
        } else {
            icon.classList.remove('fas');
            icon.classList.add('far');
            showNotification('Bookmark removed');
        }
    }

    function shareAudiobook() {
        showNotification('Share link copied to clipboard!');
    }

    function toggleReadAlongText() {
        readAlongContent.classList.toggle('collapsed');
        toggleTextBtn.classList.toggle('collapsed');
    }

    /**
     * Save playback position — debounced API call + localStorage fallback
     */
    function savePlaybackPosition() {
        localStorage.setItem('audiobook_chapter', currentChapterIndex);
        localStorage.setItem('audiobook_position', audio ? audio.currentTime : 0);

        // Debounced API save
        if (progressSaveTimer) clearTimeout(progressSaveTimer);
        progressSaveTimer = setTimeout(async () => {
            if (audiobookId && typeof EbookVoiceAPI !== 'undefined') {
                try {
                    await EbookVoiceAPI.updateProgress(audiobookId, audio ? audio.currentTime : 0, currentChapterIndex);
                } catch (e) { /* silent */ }
            }
        }, 10000);
    }

    // Also save on timeupdate every 10s
    let lastSaveTime = 0;
    if (audio) {
        audio.addEventListener('timeupdate', () => {
            const now = Date.now();
            if (now - lastSaveTime > 10000) {
                lastSaveTime = now;
                savePlaybackPosition();
            }
        });
    }

    /**
     * Handle keyboard shortcuts
     */
    function handleKeyboardShortcuts(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch(e.key) {
            case ' ':
                e.preventDefault();
                togglePlayPause();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                rewind();
                break;
            case 'ArrowRight':
                e.preventDefault();
                forward();
                break;
            case 'ArrowUp':
                e.preventDefault();
                volumeSlider.value = Math.min(100, parseInt(volumeSlider.value) + 10);
                updateVolume();
                break;
            case 'ArrowDown':
                e.preventDefault();
                volumeSlider.value = Math.max(0, parseInt(volumeSlider.value) - 10);
                updateVolume();
                break;
            case 'n':
            case 'N':
                switchToNextChapter();
                break;
            case 'p':
            case 'P':
                switchToPrevChapter();
                break;
            case '?':
                document.getElementById('shortcutsOverlay').style.display = 'flex';
                break;
        }
    }

    // Event listeners
    if (playPauseBtn) playPauseBtn.addEventListener('click', togglePlayPause);
    if (prevChapterBtn) prevChapterBtn.addEventListener('click', switchToPrevChapter);
    if (nextChapterBtn) nextChapterBtn.addEventListener('click', switchToNextChapter);
    if (rewindBtn) rewindBtn.addEventListener('click', rewind);
    if (forwardBtn) forwardBtn.addEventListener('click', forward);
    if (progressBar) progressBar.addEventListener('click', seekTo);
    if (volumeSlider) volumeSlider.addEventListener('input', updateVolume);
    if (speedBtn) speedBtn.addEventListener('click', toggleSpeedMenu);
    if (bookmarkBtn) bookmarkBtn.addEventListener('click', toggleBookmark);
    if (shareBtn) shareBtn.addEventListener('click', shareAudiobook);
    if (toggleTextBtn) toggleTextBtn.addEventListener('click', toggleReadAlongText);

    speedOptions.forEach(option => {
        option.addEventListener('click', () => {
            setPlaybackSpeed(parseFloat(option.dataset.speed));
        });
    });

    // Chapter selection (delegated for dynamic content)
    const chaptersListEl = document.querySelector('.chapters-list');
    if (chaptersListEl) {
        chaptersListEl.addEventListener('click', (e) => {
            const chapterItem = e.target.closest('.chapter-item');
            if (chapterItem) {
                const chapterNum = parseInt(chapterItem.dataset.chapter);
                switchToChapter(chapterNum - 1);
            }
        });
    }

    if (mobileChapterToggle) {
        mobileChapterToggle.addEventListener('click', () => {
            chaptersSidebar.classList.toggle('mobile-open');
        });
    }

    document.addEventListener('click', (e) => {
        if (chaptersSidebar && chaptersSidebar.classList.contains('mobile-open')) {
            if (!chaptersSidebar.contains(e.target) && e.target !== mobileChapterToggle) {
                chaptersSidebar.classList.remove('mobile-open');
            }
        }
    });

    document.addEventListener('keydown', handleKeyboardShortcuts);

    const closeShortcuts = document.getElementById('closeShortcuts');
    const shortcutsOverlay = document.getElementById('shortcutsOverlay');
    if (closeShortcuts) {
        closeShortcuts.addEventListener('click', () => { shortcutsOverlay.style.display = 'none'; });
    }
    if (shortcutsOverlay) {
        shortcutsOverlay.addEventListener('click', (e) => {
            if (e.target === shortcutsOverlay) shortcutsOverlay.style.display = 'none';
        });
    }

    console.log('Audio player initialized');
}

// ===================================
// Enhanced Initialization
// ===================================

// Wrap existing DOMContentLoaded in a check
const originalInit = () => {
    // Initialize theme
    initializeTheme();

    // Add animation styles
    addAnimationStyles();
    addDashboardAnimations();

    // Initialize event listeners
    initializeEventListeners();

    // Update navbar with real user profile (from api.js)
    if (typeof updateNavbarProfile === 'function') {
        updateNavbarProfile();
    }

    // Check which page we're on
    if (isPlayerPage()) {
        // Audio player page
        initializeAudioPlayer();
    } else if (isEditorPage()) {
        // Editor page
        initializeEditor();
    } else if (isSettingsPage()) {
        // Settings page
        initializeSettings();
    } else if (isDashboardPage()) {
        // Dashboard-specific initialization
        initializeDashboard();
    } else {
        // Landing page-specific initialization
        initializeScrollReveal();
        animateStats();
        setTimeout(revealOnScroll, 100);
    }

    recoverActiveConversion();
};

// Override the existing DOMContentLoaded event
document.addEventListener('DOMContentLoaded', originalInit);

// ===================================
// EBOOK EDITOR FUNCTIONALITY
// ===================================

/**
 * Detect if we're on the editor page
 */
function isEditorPage() {
    return window.location.pathname.includes('create.html') ||
           document.querySelector('.editor-main') !== null;
}

/**
 * Initialize ebook editor
 */
async function initializeEditor() {
    if (!isEditorPage()) return;

    // Auth guard
    if (typeof requireAuth === 'function') {
        const authed = await requireAuth();
        if (!authed) return;
    }

    // Editor state
    let bookData = loadBookData();
    let currentChapterId = bookData.chapters.length > 0 ? bookData.chapters[0].id : null;
    let autoSaveInterval = null;
    let isSaving = false;

    // Get DOM elements
    const bookTitleInput = document.getElementById('bookTitle');
    const bookAuthorInput = document.getElementById('bookAuthor');
    const bookGenreSelect = document.getElementById('bookGenre');
    const bookCoverUpload = document.getElementById('bookCoverUpload');
    const coverInput = document.getElementById('coverInput');
    const chaptersList = document.getElementById('chaptersList');
    const addChapterBtn = document.getElementById('addChapterBtn');
    const editorArea = document.getElementById('editorArea');
    const currentChapterTitle = document.getElementById('currentChapterTitle');
    const autoSaveIndicator = document.getElementById('autoSaveIndicator');
    const toolbarButtons = document.querySelectorAll('.toolbar-btn');
    const focusModeBtn = document.getElementById('focusModeBtn');
    const prevChapterEditorBtn = document.getElementById('prevChapterEditorBtn');
    const nextChapterEditorBtn = document.getElementById('nextChapterEditorBtn');
    const mobileChapterToggleEditor = document.getElementById('mobileChapterToggleEditor');
    const chapterSidebar = document.getElementById('chapterSidebar');
    const toggleRightSidebarBtn = document.getElementById('toggleRightSidebarBtn');
    const rightSidebar = document.getElementById('rightSidebar');
    const deleteModal = document.getElementById('deleteModal');
    let chapterToDelete = null;

    /**
     * Load book data from localStorage
     */
    function loadBookData() {
        const saved = localStorage.getItem('ebook_data');
        if (saved) {
            return JSON.parse(saved);
        }
        return {
            title: '',
            author: '',
            genre: '',
            cover: null,
            chapters: [
                { id: 1, title: 'Chapter 1', content: '', wordCount: 0, status: 'draft', notes: '', includeInAudiobook: true }
            ]
        };
    }

    /**
     * Save book data to localStorage
     */
    function saveBookData() {
        isSaving = true;
        updateAutoSaveIndicator('saving');

        localStorage.setItem('ebook_data', JSON.stringify(bookData));

        setTimeout(() => {
            isSaving = false;
            updateAutoSaveIndicator('saved');
        }, 500);
    }

    /**
     * Update auto-save indicator
     */
    function updateAutoSaveIndicator(state) {
        const icon = autoSaveIndicator.querySelector('i');
        const text = autoSaveIndicator.querySelector('.save-text');

        if (state === 'saving') {
            icon.className = 'fas fa-spinner';
            autoSaveIndicator.classList.add('saving');
            text.textContent = 'Saving...';
        } else {
            icon.className = 'fas fa-check-circle';
            autoSaveIndicator.classList.remove('saving');
            const now = new Date();
            text.textContent = 'All changes saved';
        }
    }

    /**
     * Count words in text
     */
    function countWords(text) {
        return text.trim().split(/\s+/).filter(word => word.length > 0).length;
    }

    /**
     * Update word counts
     */
    function updateWordCounts() {
        const currentChapter = bookData.chapters.find(ch => ch.id === currentChapterId);
        if (!currentChapter) return;

        const text = editorArea.textContent || editorArea.innerText;
        currentChapter.wordCount = countWords(text);
        currentChapter.content = editorArea.innerHTML;

        // Update displays
        document.getElementById('currentChapterWordCount').textContent = `${currentChapter.wordCount} words`;
        document.getElementById('rightChapterWords').textContent = `${currentChapter.wordCount} words`;

        // Update total
        const totalWords = bookData.chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
        document.getElementById('totalWords').textContent = totalWords;
        document.getElementById('headerWordCount').textContent = `${totalWords} words total`;
        document.getElementById('rightTotalWords').textContent = `${totalWords} words`;

        // Update reading time (average 200 words/min)
        const readingMins = Math.ceil(totalWords / 200);
        document.getElementById('readingTime').textContent = `${readingMins} min`;

        // Update characters
        document.getElementById('characterCount').textContent = text.length;

        // Update chapter in sidebar
        const chapterItem = document.querySelector(`.chapter-item-editor[data-chapter-id="${currentChapterId}"]`);
        if (chapterItem) {
            chapterItem.querySelector('.chapter-word-count').textContent = `${currentChapter.wordCount} words`;
        }
    }

    /**
     * Render chapters list
     */
    function renderChaptersList() {
        chaptersList.innerHTML = '';

        bookData.chapters.forEach((chapter, index) => {
            const chapterEl = document.createElement('div');
            chapterEl.className = `chapter-item-editor ${chapter.id === currentChapterId ? 'active' : ''}`;
            chapterEl.setAttribute('data-chapter-id', chapter.id);
            chapterEl.setAttribute('draggable', 'true');

            chapterEl.innerHTML = `
                <div class="chapter-drag-handle">
                    <i class="fas fa-grip-vertical"></i>
                </div>
                <div class="chapter-info-editor">
                    <input type="text" class="chapter-title-input" value="${chapter.title}" placeholder="Chapter Title">
                    <div class="chapter-meta-editor">
                        <span class="chapter-word-count">${chapter.wordCount} words</span>
                        <span class="chapter-status-badge ${chapter.status}">${chapter.status}</span>
                    </div>
                </div>
                <div class="chapter-actions-editor">
                    <button class="btn-icon-sm delete-chapter-btn" title="Delete Chapter">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;

            // Click to switch chapter
            chapterEl.addEventListener('click', (e) => {
                if (!e.target.closest('.chapter-title-input') && !e.target.closest('.delete-chapter-btn')) {
                    switchToChapter(chapter.id);
                }
            });

            // Chapter title input
            const titleInput = chapterEl.querySelector('.chapter-title-input');
            titleInput.addEventListener('change', (e) => {
                chapter.title = e.target.value;
                saveBookData();
            });
            titleInput.addEventListener('click', (e) => e.stopPropagation());

            // Delete button
            const deleteBtn = chapterEl.querySelector('.delete-chapter-btn');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (bookData.chapters.length === 1) {
                    showNotification('Cannot delete the last chapter');
                    return;
                }
                chapterToDelete = chapter.id;
                deleteModal.style.display = 'flex';
            });

            chaptersList.appendChild(chapterEl);
        });

        // Update counts
        document.getElementById('totalChapters').textContent = bookData.chapters.length;
        document.getElementById('totalChaptersNav').textContent = bookData.chapters.length;
        document.getElementById('tierLimits').textContent = `${bookData.chapters.length}/10 chapters used`;
    }

    /**
     * Switch to a chapter
     */
    function switchToChapter(chapterId) {
        // Save current chapter first
        if (currentChapterId) {
            const current = bookData.chapters.find(ch => ch.id === currentChapterId);
            if (current) {
                current.content = editorArea.innerHTML;
                current.title = currentChapterTitle.value;
            }
        }

        // Load new chapter
        currentChapterId = chapterId;
        const chapter = bookData.chapters.find(ch => ch.id === chapterId);
        if (!chapter) return;

        editorArea.innerHTML = chapter.content;
        currentChapterTitle.value = chapter.title;

        // Update navigation
        const currentIndex = bookData.chapters.findIndex(ch => ch.id === chapterId);
        document.getElementById('currentChapterNum').textContent = currentIndex + 1;
        prevChapterEditorBtn.disabled = currentIndex === 0;
        nextChapterEditorBtn.disabled = currentIndex === bookData.chapters.length - 1;

        // Update sidebar
        document.getElementById('includeInAudiobook').checked = chapter.includeInAudiobook;
        document.getElementById('chapterNotes').value = chapter.notes || '';

        renderChaptersList();
        updateWordCounts();
        saveBookData();
    }

    /**
     * Add new chapter
     */
    function addNewChapter() {
        const newId = Math.max(...bookData.chapters.map(ch => ch.id), 0) + 1;
        const newChapter = {
            id: newId,
            title: `Chapter ${newId}`,
            content: '',
            wordCount: 0,
            status: 'draft',
            notes: '',
            includeInAudiobook: true
        };

        bookData.chapters.push(newChapter);
        renderChaptersList();
        switchToChapter(newId);
        showNotification('New chapter added');
    }

    /**
     * Delete chapter
     */
    function deleteChapter(chapterId) {
        const index = bookData.chapters.findIndex(ch => ch.id === chapterId);
        if (index === -1) return;

        bookData.chapters.splice(index, 1);

        // Switch to another chapter
        if (currentChapterId === chapterId) {
            const newChapter = bookData.chapters[Math.max(0, index - 1)];
            switchToChapter(newChapter.id);
        }

        renderChaptersList();
        saveBookData();
        showNotification('Chapter deleted');
    }

    /**
     * Handle toolbar commands
     */
    function execCommand(command, value = null) {
        editorArea.focus();
        document.execCommand(command, false, value);
        updateWordCounts();
    }

    /**
     * Toggle focus mode
     */
    function toggleFocusMode() {
        document.body.classList.toggle('focus-mode');
        const icon = focusModeBtn.querySelector('i');
        if (document.body.classList.contains('focus-mode')) {
            icon.classList.remove('fa-expand');
            icon.classList.add('fa-compress');
        } else {
            icon.classList.remove('fa-compress');
            icon.classList.add('fa-expand');
        }
    }

    /**
     * Handle cover upload
     */
    function handleCoverUpload(e) {
        const file = e.target.files[0];
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                bookData.cover = e.target.result;
                bookCoverUpload.innerHTML = `<img src="${e.target.result}" alt="Book Cover">`;
                saveBookData();
            };
            reader.readAsDataURL(file);
        }
    }

    /**
     * Initialize all event listeners
     */
    function initializeEditorListeners() {
        // Book info inputs
        if (bookTitleInput) {
            bookTitleInput.value = bookData.title;
            bookTitleInput.addEventListener('input', (e) => {
                bookData.title = e.target.value;
                saveBookData();
            });
        }

        if (bookAuthorInput) {
            bookAuthorInput.value = bookData.author;
            bookAuthorInput.addEventListener('input', (e) => {
                bookData.author = e.target.value;
                saveBookData();
            });
        }

        if (bookGenreSelect) {
            bookGenreSelect.value = bookData.genre;
            bookGenreSelect.addEventListener('change', (e) => {
                bookData.genre = e.target.value;
                saveBookData();
            });
        }

        // Cover upload
        if (bookCoverUpload && coverInput) {
            bookCoverUpload.addEventListener('click', () => coverInput.click());
            coverInput.addEventListener('change', handleCoverUpload);
            if (bookData.cover) {
                bookCoverUpload.innerHTML = `<img src="${bookData.cover}" alt="Book Cover">`;
            }
        }

        // Chapter title
        if (currentChapterTitle) {
            currentChapterTitle.addEventListener('input', (e) => {
                const chapter = bookData.chapters.find(ch => ch.id === currentChapterId);
                if (chapter) {
                    chapter.title = e.target.value;
                    saveBookData();
                }
            });
        }

        // Editor area
        if (editorArea) {
            editorArea.addEventListener('input', () => {
                updateWordCounts();
            });

            editorArea.addEventListener('paste', (e) => {
                e.preventDefault();
                const text = (e.clipboardData || window.clipboardData).getData('text/plain');
                document.execCommand('insertText', false, text);
            });
        }

        // Toolbar buttons
        toolbarButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const command = btn.dataset.command;
                const value = btn.dataset.value;
                execCommand(command, value);
                btn.classList.add('active');
                setTimeout(() => btn.classList.remove('active'), 200);
            });
        });

        // Add chapter
        if (addChapterBtn) {
            addChapterBtn.addEventListener('click', addNewChapter);
        }

        // Focus mode
        if (focusModeBtn) {
            focusModeBtn.addEventListener('click', toggleFocusMode);
        }

        // Chapter navigation
        if (prevChapterEditorBtn) {
            prevChapterEditorBtn.addEventListener('click', () => {
                const currentIndex = bookData.chapters.findIndex(ch => ch.id === currentChapterId);
                if (currentIndex > 0) {
                    switchToChapter(bookData.chapters[currentIndex - 1].id);
                }
            });
        }

        if (nextChapterEditorBtn) {
            nextChapterEditorBtn.addEventListener('click', () => {
                const currentIndex = bookData.chapters.findIndex(ch => ch.id === currentChapterId);
                if (currentIndex < bookData.chapters.length - 1) {
                    switchToChapter(bookData.chapters[currentIndex + 1].id);
                }
            });
        }

        // Mobile chapter toggle
        if (mobileChapterToggleEditor && chapterSidebar) {
            mobileChapterToggleEditor.addEventListener('click', () => {
                chapterSidebar.classList.toggle('mobile-open');
            });
        }

        // Toggle right sidebar
        if (toggleRightSidebarBtn && rightSidebar) {
            toggleRightSidebarBtn.addEventListener('click', () => {
                rightSidebar.style.display = rightSidebar.style.display === 'none' ? 'flex' : 'none';
            });
        }

        // Chapter settings
        const includeCheckbox = document.getElementById('includeInAudiobook');
        if (includeCheckbox) {
            includeCheckbox.addEventListener('change', (e) => {
                const chapter = bookData.chapters.find(ch => ch.id === currentChapterId);
                if (chapter) {
                    chapter.includeInAudiobook = e.target.checked;
                    saveBookData();
                }
            });
        }

        const chapterNotesInput = document.getElementById('chapterNotes');
        if (chapterNotesInput) {
            chapterNotesInput.addEventListener('input', (e) => {
                const chapter = bookData.chapters.find(ch => ch.id === currentChapterId);
                if (chapter) {
                    chapter.notes = e.target.value;
                    saveBookData();
                }
            });
        }

        // Bottom action bar
        const saveDraftBtn = document.getElementById('saveDraftBtn');
        if (saveDraftBtn) {
            saveDraftBtn.addEventListener('click', () => {
                saveBookData();
                showNotification('Draft saved successfully!');
            });
        }

        const convertBookBtn = document.getElementById('convertBookBtn');
        if (convertBookBtn) {
            convertBookBtn.addEventListener('click', async () => {
                if (typeof EbookVoiceAPI === 'undefined') {
                    showNotification('API not available');
                    return;
                }
                try {
                    const voices = await EbookVoiceAPI.getVoices();
                    showVoicePickerModal(voices, async (selectedVoice) => {
                        showNotification('Starting conversion...');
                        const chaptersToConvert = bookData.chapters
                            .filter(ch => ch.includeInAudiobook)
                            .map(ch => ({
                                title: ch.title,
                                text: ch.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
                            }));

                        if (chaptersToConvert.length === 0) {
                            showNotification('No chapters to convert. Write some content first.');
                            return;
                        }

                        try {
                            const task = await EbookVoiceAPI.convertChapters(
                                chaptersToConvert,
                                selectedVoice.id,
                                bookData.title || 'Untitled'
                            );

                            const bookTitle = bookData.title || 'Untitled';
                            const modal = showConversionModal(bookTitle);
                            let pill = null;
                            let lastPct = 0;

                            // Persist task so recovery works if user navigates away
                            localStorage.setItem('activeConversion', JSON.stringify({
                                taskId: task.taskId,
                                title: bookTitle,
                                startedAt: Date.now(),
                            }));

                            modal.onBackground(() => {
                                modal.close();
                                pill = activateConversionPill(bookTitle);
                                pill.update(lastPct);
                            });

                            await EbookVoiceAPI.pollConversionStatus(task.taskId, (status) => {
                                lastPct = status.progress || 0;
                                modal.update(lastPct);
                                if (pill) pill.update(lastPct);
                            });

                            localStorage.removeItem('activeConversion');
                            if (pill) pill.complete(bookTitle);
                            modal.succeed();

                        } catch (err) {
                            localStorage.removeItem('activeConversion');
                            // ── Monetization gate ─────────────────────────────
                            if (err.body?.conversion_limit_reached || err.status === 403) {
                                const convModal = document.getElementById('conversionModal');
                                if (convModal) convModal.remove();
                                showUpgradeModal();
                            } else {
                                const errMsg = err.message || 'Unknown error';
                                if (document.getElementById('conversionModal')) {
                                    modal.fail(errMsg);
                                } else {
                                    showNotification('Conversion failed: ' + errMsg);
                                }
                            }
                            console.error(err);
                        }
                    });
                } catch (err) {
                    showNotification('Failed to load voices');
                    console.error(err);
                }
            });
        }

        const exportBookBtn = document.getElementById('exportBookBtn');
        if (exportBookBtn) {
            exportBookBtn.addEventListener('click', () => {
                showNotification('Exporting ebook...');
            });
        }

        // Quick actions
        const previewChapterBtn = document.getElementById('previewChapterBtn');
        if (previewChapterBtn) {
            previewChapterBtn.addEventListener('click', () => {
                showNotification('Opening preview...');
            });
        }

        const convertChapterBtn = document.getElementById('convertChapterBtn');
        if (convertChapterBtn) {
            convertChapterBtn.addEventListener('click', async () => {
                if (typeof EbookVoiceAPI === 'undefined') { showNotification('API not available'); return; }
                try {
                    const voices = await EbookVoiceAPI.getVoices();
                    showVoicePickerModal(voices, async (selectedVoice) => {
                        const chapter = bookData.chapters.find(ch => ch.id === currentChapterId);
                        if (!chapter) { showNotification('No chapter selected'); return; }
                        const text = chapter.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                        if (!text) { showNotification('Chapter is empty'); return; }

                        try {
                            const task = await EbookVoiceAPI.convertText(text, selectedVoice.id);
                            const chapterTitle = chapter.title || 'Chapter';
                            const modal = showConversionModal(chapterTitle);
                            let pill = null;
                            let lastPct = 0;

                            localStorage.setItem('activeConversion', JSON.stringify({
                                taskId: task.taskId,
                                title: chapterTitle,
                                startedAt: Date.now(),
                            }));

                            modal.onBackground(() => {
                                modal.close();
                                pill = activateConversionPill(chapterTitle);
                                pill.update(lastPct);
                            });

                            await EbookVoiceAPI.pollConversionStatus(task.taskId, (status) => {
                                lastPct = status.progress || 0;
                                modal.update(lastPct);
                                if (pill) pill.update(lastPct);
                            });

                            localStorage.removeItem('activeConversion');
                            if (pill) pill.complete(chapterTitle);
                            modal.succeed();

                        } catch (err) {
                            localStorage.removeItem('activeConversion');
                            // ── Monetization gate ─────────────────────────────
                            if (err.body?.conversion_limit_reached || err.status === 403) {
                                const convModal = document.getElementById('conversionModal');
                                if (convModal) convModal.remove();
                                showUpgradeModal();
                            } else {
                                showNotification('Conversion failed: ' + (err.message || 'Unknown error'));
                            }
                        }
                    });
                } catch (err) {
                    showNotification('Failed to load voices');
                }
            });
        }

        const generateAudioPreviewBtn = document.getElementById('generateAudioPreviewBtn');
        if (generateAudioPreviewBtn) {
            generateAudioPreviewBtn.addEventListener('click', async () => {
                if (typeof EbookVoiceAPI === 'undefined') { showNotification('API not available'); return; }
                const chapter = bookData.chapters.find(ch => ch.id === currentChapterId);
                if (!chapter) { showNotification('No chapter selected'); return; }
                const text = chapter.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                if (!text) { showNotification('Chapter is empty'); return; }

                // Take first 250 chars for preview
                const previewText = text.substring(0, 250);

                try {
                    const voices = await EbookVoiceAPI.getVoices();
                    showVoicePickerModal(voices, async (selectedVoice) => {
                        showNotification('Generating audio preview...');
                        try {
                            const task = await EbookVoiceAPI.convertText(previewText, selectedVoice.id);
                            const result = await EbookVoiceAPI.pollConversionStatus(task.taskId, (status) => {
                                showNotification(`Generating: ${status.progress || 0}%`);
                            });
                            if (result.audioUrl) {
                                const previewAudio = new Audio(result.audioUrl);
                                previewAudio.play();
                                showNotification('Playing audio preview');
                            }
                        } catch (err) {
                            showNotification('Preview failed: ' + (err.message || 'Unknown error'));
                        }
                    });
                } catch (err) {
                    showNotification('Failed to load voices');
                }
            });
        }

        // Delete modal
        const closeDeleteModal = document.getElementById('closeDeleteModal');
        const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
        const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

        if (closeDeleteModal) {
            closeDeleteModal.addEventListener('click', () => {
                deleteModal.style.display = 'none';
            });
        }

        if (cancelDeleteBtn) {
            cancelDeleteBtn.addEventListener('click', () => {
                deleteModal.style.display = 'none';
            });
        }

        if (confirmDeleteBtn) {
            confirmDeleteBtn.addEventListener('click', () => {
                if (chapterToDelete) {
                    deleteChapter(chapterToDelete);
                    chapterToDelete = null;
                }
                deleteModal.style.display = 'none';
            });
        }

        // Click outside modal to close
        if (deleteModal) {
            deleteModal.addEventListener('click', (e) => {
                if (e.target === deleteModal) {
                    deleteModal.style.display = 'none';
                }
            });
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                if (e.target === editorArea) {
                    // Allow shortcuts in editor
                } else {
                    return;
                }
            }

            if (e.ctrlKey || e.metaKey) {
                switch (e.key.toLowerCase()) {
                    case 's':
                        e.preventDefault();
                        saveBookData();
                        showNotification('Saved!');
                        break;
                    case 'b':
                        if (e.target === editorArea) {
                            e.preventDefault();
                            execCommand('bold');
                        }
                        break;
                    case 'i':
                        if (e.target === editorArea) {
                            e.preventDefault();
                            execCommand('italic');
                        }
                        break;
                    case 'u':
                        if (e.target === editorArea) {
                            e.preventDefault();
                            execCommand('underline');
                        }
                        break;
                }
            }

            if (e.key === 'F11') {
                e.preventDefault();
                toggleFocusMode();
            }
        });
    }

    // Initialize
    renderChaptersList();
    if (currentChapterId) {
        switchToChapter(currentChapterId);
    }
    initializeEditorListeners();

    // Auto-save every 30 seconds
    autoSaveInterval = setInterval(() => {
        if (!isSaving) {
            saveBookData();
        }
    }, 30000);

    console.log('✍️ Editor initialized successfully!');
}

// ===================================
// VOICE PICKER MODAL
// ===================================

/**
 * Show a modal to pick a voice for conversion.
 * @param {Array} voices - Array of voice objects from API
 * @param {Function} onSelect - Callback called with selected voice
 */
function showVoicePickerModal(voices, onSelect) {
    // Remove existing modal if any
    const existing = document.getElementById('voicePickerModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'voicePickerModal';
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';

    modal.innerHTML = `
        <div class="modal-panel" style="max-width: 560px; max-height: 80vh; overflow-y: auto;">
            <div class="modal-header">
                <h3><i class="fas fa-microphone"></i> Select a Voice</h3>
                <button class="close-modal" id="closeVoiceModal">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body" style="padding: 16px;">
                <div class="voice-cards" style="display: grid; gap: 12px;">
                    ${voices.map(v => `
                        <div class="voice-card" data-voice-id="${v.id}" style="
                            padding: 14px 16px;
                            border: 2px solid var(--border-color);
                            border-radius: 12px;
                            cursor: pointer;
                            transition: all 0.2s;
                            display: flex;
                            align-items: center;
                            gap: 12px;
                        ">
                            <div style="
                                width: 40px; height: 40px;
                                border-radius: 50%;
                                background: var(--gradient);
                                display: flex; align-items: center; justify-content: center;
                                color: white; font-size: 16px; flex-shrink: 0;
                            ">
                                <i class="fas ${v.gender === 'Female' ? 'fa-venus' : 'fa-mars'}"></i>
                            </div>
                            <div style="flex: 1;">
                                <div style="font-weight: 600; font-size: 0.95rem; color: var(--text-primary);">${v.name}</div>
                                <div style="font-size: 0.8rem; color: var(--text-secondary);">${v.description || v.locale || ''}</div>
                            </div>
                            <button class="voice-preview-btn btn-icon" data-voice="${v.id}" title="Preview voice" style="flex-shrink:0;">
                                <i class="fas fa-play"></i>
                            </button>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close modal
    const close = () => modal.remove();
    document.getElementById('closeVoiceModal').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    // Voice card click to select
    modal.querySelectorAll('.voice-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.voice-preview-btn')) return;
            const voiceId = card.dataset.voiceId;
            const voice = voices.find(v => v.id === voiceId);
            close();
            if (voice && onSelect) onSelect(voice);
        });

        // Hover effect
        card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent-primary)'; card.style.background = 'var(--bg-secondary)'; });
        card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border-color)'; card.style.background = ''; });
    });

    // Preview buttons
    modal.querySelectorAll('.voice-preview-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const voiceId = btn.dataset.voice;
            if (typeof EbookVoiceAPI !== 'undefined') {
                const url = EbookVoiceAPI.getVoicePreviewUrl(voiceId);
                const previewAudio = new Audio(url);
                previewAudio.play().catch(() => showNotification('Preview not available'));
            }
        });
    });
}

// ===================================
// SETTINGS PAGE FUNCTIONALITY
// ===================================

/**
 * Detect if we're on the settings page
 */
function isSettingsPage() {
    return window.location.pathname.includes('settings.html') ||
           document.querySelector('.settings-main') !== null;
}

/**
 * Initialize settings page
 */
async function initializeSettings() {
    if (!isSettingsPage()) return;

    // Auth guard
    if (typeof requireAuth === 'function') {
        const authed = await requireAuth();
        if (!authed) return;
    }

    // Load saved settings
    let settingsData = loadSettings();

    // Get DOM elements
    const settingsSidebar = document.querySelector('.settings-sidebar');
    const settingsNavItems = document.querySelectorAll('.settings-nav-item');
    const settingsSections = document.querySelectorAll('.settings-section');
    const settingsSearchInput = document.getElementById('settingsSearch');
    const mobileSettingsToggle = document.getElementById('mobileSettingsToggle');

    // Profile elements
    const profileAvatar = document.getElementById('profileAvatar');
    const avatarInput = document.getElementById('avatarInput');
    const changeAvatarBtn = document.getElementById('changeAvatarBtn');
    const usernameInput = document.getElementById('username');
    const displayNameInput = document.getElementById('displayName');
    const bioInput = document.getElementById('bio');

    // Account elements
    const emailInput = document.getElementById('email');
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    const languageSelect = document.getElementById('language');
    const timezoneSelect = document.getElementById('timezone');
    const deleteAccountBtn = document.getElementById('deleteAccountBtn');

    // Theme elements
    const themeRadios = document.querySelectorAll('input[name="theme"]');

    // Toggle switches
    const allToggles = document.querySelectorAll('.toggle-switch input[type="checkbox"]');

    // Modals
    const changePasswordModal = document.getElementById('changePasswordModal');
    const deleteAccountModal = document.getElementById('deleteAccountModal');
    const closePasswordModalBtn = document.getElementById('closePasswordModal');
    const cancelPasswordBtn = document.getElementById('cancelPasswordBtn');
    const closeDeleteAccountModalBtn = document.getElementById('closeDeleteAccountModal');
    const cancelDeleteAccountBtn = document.getElementById('cancelDeleteAccountBtn');

    /**
     * Load settings from localStorage
     */
    function loadSettings() {
        const saved = localStorage.getItem('user_settings');
        if (saved) {
            return JSON.parse(saved);
        }
        return {
            profile: {
                username: 'johndoe',
                displayName: 'John Doe',
                email: 'john.doe@example.com',
                bio: '',
                avatar: 'https://ui-avatars.com/api/?name=John+Doe&background=6366f1&color=fff',
                memberSince: 'January 2025'
            },
            account: {
                language: 'en',
                timezone: 'UTC-5',
                connectedAccounts: {
                    google: true,
                    facebook: false
                }
            },
            preferences: {
                theme: 'light',
                autoPlayNext: true,
                emailNotifications: true,
                marketingEmails: false,
                updateNotifications: true,
                defaultPlaybackSpeed: '1',
                defaultAudioFormat: 'mp3',
                autoSaveInterval: '30'
            },
            audio: {
                defaultVoice: 'natural',
                audioQuality: 'high',
                chapterTransitions: 'smooth',
                readAlongSync: true,
                autoDownload: false
            },
            privacy: {
                twoFactorAuth: false,
                profileVisibility: 'public',
                shareStatistics: true
            }
        };
    }

    /**
     * Save settings to localStorage
     */
    function saveSettings() {
        localStorage.setItem('user_settings', JSON.stringify(settingsData));
        showNotification('Settings saved successfully!');
    }

    /**
     * Switch to settings section
     */
    function switchToSection(sectionId) {
        // Update navigation
        settingsNavItems.forEach(item => {
            item.classList.remove('active');
            if (item.dataset.section === sectionId) {
                item.classList.add('active');
            }
        });

        // Update sections
        settingsSections.forEach(section => {
            section.classList.remove('active');
            if (section.id === sectionId) {
                section.classList.add('active');
            }
        });

        // Close mobile sidebar if open
        if (settingsSidebar && settingsSidebar.classList.contains('mobile-open')) {
            settingsSidebar.classList.remove('mobile-open');
        }

        // Update URL hash
        window.location.hash = sectionId;

        // Scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /**
     * Handle avatar upload
     */
    function handleAvatarUpload(e) {
        const file = e.target.files[0];
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                settingsData.profile.avatar = e.target.result;
                profileAvatar.src = e.target.result;
                saveSettings();
            };
            reader.readAsDataURL(file);
        }
    }

    /**
     * Handle theme change
     */
    function handleThemeChange(theme) {
        settingsData.preferences.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        updateThemeIcon(theme);
        saveSettings();
    }

    /**
     * Search settings
     */
    function searchSettings(query) {
        const searchTerm = query.toLowerCase().trim();

        if (!searchTerm) {
            // Show all sections
            settingsSections.forEach(section => {
                section.style.display = 'block';
            });
            return;
        }

        // Hide all sections first
        settingsSections.forEach(section => {
            section.style.display = 'none';
        });

        // Show sections that match
        settingsSections.forEach(section => {
            const sectionText = section.textContent.toLowerCase();
            if (sectionText.includes(searchTerm)) {
                section.style.display = 'block';
            }
        });
    }

    /**
     * Reset section to defaults
     */
    function resetSectionToDefaults(sectionId) {
        const defaultSettings = {
            profile: {
                username: 'johndoe',
                displayName: 'John Doe',
                bio: ''
            },
            preferences: {
                autoPlayNext: true,
                emailNotifications: true,
                marketingEmails: false,
                updateNotifications: true,
                defaultPlaybackSpeed: '1',
                defaultAudioFormat: 'mp3',
                autoSaveInterval: '30'
            },
            audio: {
                defaultVoice: 'natural',
                audioQuality: 'high',
                chapterTransitions: 'smooth',
                readAlongSync: true,
                autoDownload: false
            },
            privacy: {
                twoFactorAuth: false,
                profileVisibility: 'public',
                shareStatistics: true
            }
        };

        // Reset based on section
        if (sectionId === 'profile' && defaultSettings.profile) {
            Object.assign(settingsData.profile, defaultSettings.profile);
            loadProfileData();
        } else if (sectionId === 'preferences' && defaultSettings.preferences) {
            Object.assign(settingsData.preferences, defaultSettings.preferences);
            loadPreferencesData();
        } else if (sectionId === 'audio' && defaultSettings.audio) {
            Object.assign(settingsData.audio, defaultSettings.audio);
            loadAudioData();
        } else if (sectionId === 'privacy' && defaultSettings.privacy) {
            Object.assign(settingsData.privacy, defaultSettings.privacy);
            loadPrivacyData();
        }

        saveSettings();
        showNotification('Settings reset to defaults');
    }

    /**
     * Load profile data into form
     */
    function loadProfileData() {
        if (usernameInput) usernameInput.value = settingsData.profile.username;
        if (displayNameInput) displayNameInput.value = settingsData.profile.displayName;
        if (bioInput) bioInput.value = settingsData.profile.bio;
        if (profileAvatar) profileAvatar.src = settingsData.profile.avatar;
    }

    /**
     * Load account data into form
     */
    function loadAccountData() {
        if (emailInput) emailInput.value = settingsData.profile.email;
        if (languageSelect) languageSelect.value = settingsData.account.language;
        if (timezoneSelect) timezoneSelect.value = settingsData.account.timezone;
    }

    /**
     * Load preferences data into form
     */
    function loadPreferencesData() {
        // Theme
        themeRadios.forEach(radio => {
            if (radio.value === settingsData.preferences.theme) {
                radio.checked = true;
                radio.parentElement.classList.add('active');
            } else {
                radio.parentElement.classList.remove('active');
            }
        });

        // Toggles and selects
        const autoPlayNext = document.getElementById('autoPlayNextChapter');
        if (autoPlayNext) autoPlayNext.checked = settingsData.preferences.autoPlayNext;

        const emailNotifications = document.getElementById('emailNotifications');
        if (emailNotifications) emailNotifications.checked = settingsData.preferences.emailNotifications;

        const marketingEmails = document.getElementById('marketingEmails');
        if (marketingEmails) marketingEmails.checked = settingsData.preferences.marketingEmails;

        const updateNotifications = document.getElementById('updateNotifications');
        if (updateNotifications) updateNotifications.checked = settingsData.preferences.updateNotifications;

        const playbackSpeed = document.getElementById('defaultPlaybackSpeed');
        if (playbackSpeed) playbackSpeed.value = settingsData.preferences.defaultPlaybackSpeed;

        const audioFormat = document.getElementById('defaultAudioFormat');
        if (audioFormat) audioFormat.value = settingsData.preferences.defaultAudioFormat;

        const autoSaveInterval = document.getElementById('autoSaveInterval');
        if (autoSaveInterval) autoSaveInterval.value = settingsData.preferences.autoSaveInterval;
    }

    /**
     * Load audio data into form
     */
    function loadAudioData() {
        const defaultVoice = document.getElementById('defaultVoice');
        if (defaultVoice) defaultVoice.value = settingsData.audio.defaultVoice;

        const audioQuality = document.getElementById('audioQuality');
        if (audioQuality) audioQuality.value = settingsData.audio.audioQuality;

        const chapterTransitions = document.getElementById('chapterTransitions');
        if (chapterTransitions) chapterTransitions.value = settingsData.audio.chapterTransitions;

        const readAlongSync = document.getElementById('readAlongSync');
        if (readAlongSync) readAlongSync.checked = settingsData.audio.readAlongSync;

        const autoDownload = document.getElementById('autoDownload');
        if (autoDownload) autoDownload.checked = settingsData.audio.autoDownload;
    }

    /**
     * Load privacy data into form
     */
    function loadPrivacyData() {
        const profileVisibility = document.getElementById('profileVisibility');
        if (profileVisibility) profileVisibility.value = settingsData.privacy.profileVisibility;

        const shareStatistics = document.getElementById('shareStatistics');
        if (shareStatistics) shareStatistics.checked = settingsData.privacy.shareStatistics;
    }

    /**
     * Initialize event listeners
     */
    function initializeSettingsListeners() {
        // Navigation
        settingsNavItems.forEach(item => {
            item.addEventListener('click', () => {
                switchToSection(item.dataset.section);
            });
        });

        // Mobile toggle
        if (mobileSettingsToggle && settingsSidebar) {
            mobileSettingsToggle.addEventListener('click', () => {
                settingsSidebar.classList.toggle('mobile-open');
            });
        }

        // Search
        if (settingsSearchInput) {
            settingsSearchInput.addEventListener('input', (e) => {
                searchSettings(e.target.value);
            });
        }

        // Profile - Avatar upload
        if (changeAvatarBtn && avatarInput) {
            changeAvatarBtn.addEventListener('click', () => avatarInput.click());
            avatarInput.addEventListener('change', handleAvatarUpload);
        }

        // Profile - Inputs
        if (usernameInput) {
            usernameInput.addEventListener('change', (e) => {
                settingsData.profile.username = e.target.value;
                saveSettings();
            });
        }

        if (displayNameInput) {
            displayNameInput.addEventListener('change', (e) => {
                settingsData.profile.displayName = e.target.value;
                saveSettings();
            });
        }

        if (bioInput) {
            bioInput.addEventListener('change', (e) => {
                settingsData.profile.bio = e.target.value;
                saveSettings();
            });
        }

        // Account - Email
        if (emailInput) {
            emailInput.addEventListener('change', (e) => {
                settingsData.profile.email = e.target.value;
                saveSettings();
            });
        }

        // Account - Language & Timezone
        if (languageSelect) {
            languageSelect.addEventListener('change', (e) => {
                settingsData.account.language = e.target.value;
                saveSettings();
            });
        }

        if (timezoneSelect) {
            timezoneSelect.addEventListener('change', (e) => {
                settingsData.account.timezone = e.target.value;
                saveSettings();
            });
        }

        // Password change modal
        if (changePasswordBtn && changePasswordModal) {
            changePasswordBtn.addEventListener('click', () => {
                changePasswordModal.style.display = 'flex';
            });
        }

        if (closePasswordModalBtn && changePasswordModal) {
            closePasswordModalBtn.addEventListener('click', () => {
                changePasswordModal.style.display = 'none';
            });
        }

        if (cancelPasswordBtn && changePasswordModal) {
            cancelPasswordBtn.addEventListener('click', () => {
                changePasswordModal.style.display = 'none';
            });
        }

        const savePasswordBtn = document.getElementById('savePasswordBtn');
        if (savePasswordBtn) {
            savePasswordBtn.addEventListener('click', () => {
                showNotification('Password changed successfully!');
                changePasswordModal.style.display = 'none';
            });
        }

        // Delete account modal
        if (deleteAccountBtn && deleteAccountModal) {
            deleteAccountBtn.addEventListener('click', () => {
                deleteAccountModal.style.display = 'flex';
            });
        }

        if (closeDeleteAccountModalBtn && deleteAccountModal) {
            closeDeleteAccountModalBtn.addEventListener('click', () => {
                deleteAccountModal.style.display = 'none';
            });
        }

        if (cancelDeleteAccountBtn && deleteAccountModal) {
            cancelDeleteAccountBtn.addEventListener('click', () => {
                deleteAccountModal.style.display = 'none';
            });
        }

        const confirmDeleteAccountBtn = document.getElementById('confirmDeleteAccountBtn');
        if (confirmDeleteAccountBtn) {
            confirmDeleteAccountBtn.addEventListener('click', () => {
                showNotification('Account deletion initiated');
                deleteAccountModal.style.display = 'none';
            });
        }

        // Close modals on outside click
        if (changePasswordModal) {
            changePasswordModal.addEventListener('click', (e) => {
                if (e.target === changePasswordModal) {
                    changePasswordModal.style.display = 'none';
                }
            });
        }

        if (deleteAccountModal) {
            deleteAccountModal.addEventListener('click', (e) => {
                if (e.target === deleteAccountModal) {
                    deleteAccountModal.style.display = 'none';
                }
            });
        }

        // Theme selector
        themeRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (e.target.checked) {
                    handleThemeChange(e.target.value);

                    // Update visual active state
                    document.querySelectorAll('.theme-option').forEach(opt => {
                        opt.classList.remove('active');
                    });
                    e.target.closest('.theme-option').classList.add('active');
                }
            });
        });

        // All toggle switches
        allToggles.forEach(toggle => {
            toggle.addEventListener('change', (e) => {
                const toggleId = e.target.id;
                const isChecked = e.target.checked;

                // Update settings data based on toggle ID
                switch(toggleId) {
                    case 'autoPlayNextChapter':
                        settingsData.preferences.autoPlayNext = isChecked;
                        break;
                    case 'emailNotifications':
                        settingsData.preferences.emailNotifications = isChecked;
                        break;
                    case 'marketingEmails':
                        settingsData.preferences.marketingEmails = isChecked;
                        break;
                    case 'updateNotifications':
                        settingsData.preferences.updateNotifications = isChecked;
                        break;
                    case 'readAlongSync':
                        settingsData.audio.readAlongSync = isChecked;
                        break;
                    case 'autoDownload':
                        settingsData.audio.autoDownload = isChecked;
                        break;
                    case 'shareStatistics':
                        settingsData.privacy.shareStatistics = isChecked;
                        break;
                }

                saveSettings();
            });
        });

        // Preference selects
        const defaultPlaybackSpeed = document.getElementById('defaultPlaybackSpeed');
        if (defaultPlaybackSpeed) {
            defaultPlaybackSpeed.addEventListener('change', (e) => {
                settingsData.preferences.defaultPlaybackSpeed = e.target.value;
                saveSettings();
            });
        }

        const defaultAudioFormat = document.getElementById('defaultAudioFormat');
        if (defaultAudioFormat) {
            defaultAudioFormat.addEventListener('change', (e) => {
                settingsData.preferences.defaultAudioFormat = e.target.value;
                saveSettings();
            });
        }

        const autoSaveInterval = document.getElementById('autoSaveInterval');
        if (autoSaveInterval) {
            autoSaveInterval.addEventListener('change', (e) => {
                settingsData.preferences.autoSaveInterval = e.target.value;
                saveSettings();
            });
        }

        // Audio selects
        const defaultVoice = document.getElementById('defaultVoice');
        if (defaultVoice) {
            defaultVoice.addEventListener('change', (e) => {
                settingsData.audio.defaultVoice = e.target.value;
                saveSettings();
            });
        }

        const audioQuality = document.getElementById('audioQuality');
        if (audioQuality) {
            audioQuality.addEventListener('change', (e) => {
                settingsData.audio.audioQuality = e.target.value;
                saveSettings();
            });
        }

        const chapterTransitions = document.getElementById('chapterTransitions');
        if (chapterTransitions) {
            chapterTransitions.addEventListener('change', (e) => {
                settingsData.audio.chapterTransitions = e.target.value;
                saveSettings();
            });
        }

        // Privacy selects
        const profileVisibility = document.getElementById('profileVisibility');
        if (profileVisibility) {
            profileVisibility.addEventListener('change', (e) => {
                settingsData.privacy.profileVisibility = e.target.value;
                saveSettings();
            });
        }

        // Save buttons
        const saveProfileBtn = document.getElementById('saveProfileBtn');
        if (saveProfileBtn) {
            saveProfileBtn.addEventListener('click', () => {
                saveSettings();
            });
        }

        const saveAccountBtn = document.getElementById('saveAccountBtn');
        if (saveAccountBtn) {
            saveAccountBtn.addEventListener('click', () => {
                saveSettings();
            });
        }

        const savePreferencesBtn = document.getElementById('savePreferencesBtn');
        if (savePreferencesBtn) {
            savePreferencesBtn.addEventListener('click', () => {
                saveSettings();
            });
        }

        const saveAudioBtn = document.getElementById('saveAudioBtn');
        if (saveAudioBtn) {
            saveAudioBtn.addEventListener('click', () => {
                saveSettings();
            });
        }

        const savePrivacyBtn = document.getElementById('savePrivacyBtn');
        if (savePrivacyBtn) {
            savePrivacyBtn.addEventListener('click', () => {
                saveSettings();
            });
        }

        // Reset buttons
        const resetProfileBtn = document.getElementById('resetProfileBtn');
        if (resetProfileBtn) {
            resetProfileBtn.addEventListener('click', () => {
                resetSectionToDefaults('profile');
            });
        }

        const resetPreferencesBtn = document.getElementById('resetPreferencesBtn');
        if (resetPreferencesBtn) {
            resetPreferencesBtn.addEventListener('click', () => {
                resetSectionToDefaults('preferences');
            });
        }

        const resetAudioBtn = document.getElementById('resetAudioBtn');
        if (resetAudioBtn) {
            resetAudioBtn.addEventListener('click', () => {
                resetSectionToDefaults('audio');
            });
        }

        const resetPrivacyBtn = document.getElementById('resetPrivacyBtn');
        if (resetPrivacyBtn) {
            resetPrivacyBtn.addEventListener('click', () => {
                resetSectionToDefaults('privacy');
            });
        }

        // Other buttons
        const enable2FABtn = document.getElementById('enable2FABtn');
        if (enable2FABtn) {
            enable2FABtn.addEventListener('click', () => {
                settingsData.privacy.twoFactorAuth = true;
                saveSettings();
                showNotification('2FA setup initiated');
            });
        }

        const logoutAllBtn = document.getElementById('logoutAllBtn');
        if (logoutAllBtn) {
            logoutAllBtn.addEventListener('click', () => {
                showNotification('Logged out from all sessions');
            });
        }

        const exportDataBtn = document.getElementById('exportDataBtn');
        if (exportDataBtn) {
            exportDataBtn.addEventListener('click', () => {
                const dataStr = JSON.stringify(settingsData, null, 2);
                const dataBlob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(dataBlob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'settings_data.json';
                link.click();
                showNotification('Data exported successfully');
            });
        }

        // Support buttons
        const contactSupportBtn = document.getElementById('contactSupportBtn');
        if (contactSupportBtn) {
            contactSupportBtn.addEventListener('click', () => {
                showNotification('Opening support form...');
            });
        }

        const reportBugBtn = document.getElementById('reportBugBtn');
        if (reportBugBtn) {
            reportBugBtn.addEventListener('click', () => {
                showNotification('Opening bug report form...');
            });
        }

        const featureRequestBtn = document.getElementById('featureRequestBtn');
        if (featureRequestBtn) {
            featureRequestBtn.addEventListener('click', () => {
                showNotification('Opening feature request form...');
            });
        }

        // Connected accounts
        const connectGoogleBtn = document.getElementById('connectGoogle');
        if (connectGoogleBtn) {
            connectGoogleBtn.addEventListener('click', () => {
                settingsData.account.connectedAccounts.google = !settingsData.account.connectedAccounts.google;
                saveSettings();
                const action = settingsData.account.connectedAccounts.google ? 'Connected' : 'Disconnected';
                showNotification(`${action} Google account`);
            });
        }

        const connectFacebookBtn = document.getElementById('connectFacebook');
        if (connectFacebookBtn) {
            connectFacebookBtn.addEventListener('click', () => {
                settingsData.account.connectedAccounts.facebook = !settingsData.account.connectedAccounts.facebook;
                saveSettings();
                const action = settingsData.account.connectedAccounts.facebook ? 'Connected' : 'Disconnected';
                showNotification(`${action} Facebook account`);
            });
        }
    }

    // Initialize with localStorage defaults first
    loadProfileData();
    loadAccountData();
    loadPreferencesData();
    loadAudioData();
    loadPrivacyData();
    initializeSettingsListeners();

    // Then load real profile from API to overlay real data
    if (typeof EbookVoiceAPI !== 'undefined') {
        (async () => {
            try {
                const profile = await EbookVoiceAPI.getProfile();
                if (profile) {
                    // Populate profile fields with real data
                    if (displayNameInput) displayNameInput.value = profile.displayName || profile.firstName || '';
                    if (usernameInput) usernameInput.value = profile.firstName ? `${profile.firstName.toLowerCase()}${profile.lastName ? profile.lastName.toLowerCase() : ''}` : '';

                    const profileEmailEl = document.getElementById('profileEmail');
                    if (profileEmailEl) profileEmailEl.value = profile.email || '';
                    const accountEmailEl = document.getElementById('accountEmail');
                    if (accountEmailEl) accountEmailEl.value = profile.email || '';

                    if (profileAvatar && profile.avatar) profileAvatar.src = profile.avatar;

                    // Update subscription section with real plan data
                    const tierBadge = document.querySelector('.tier-badge-large');
                    if (tierBadge) {
                        const plan = (profile.plan || 'free').toLowerCase();
                        tierBadge.className = `tier-badge-large ${plan}`;
                        tierBadge.innerHTML = `<i class="fas fa-crown"></i> ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan`;
                    }

                    const planDesc = document.querySelector('.plan-description');
                    if (planDesc) {
                        const maxConv = profile.maxMonthlyConversions || 1;
                        planDesc.textContent = `${maxConv === -1 ? 'Unlimited' : maxConv} conversions/month`;
                    }

                    const priceAmount = document.querySelector('.price-amount');
                    if (priceAmount) {
                        const prices = { free: '£0', starter: '£9.99', pro: '£19.99', enterprise: 'Custom' };
                        priceAmount.textContent = prices[(profile.plan || 'free').toLowerCase()] || '£0';
                    }

                    // Update usage stats
                    const usageStatItems = document.querySelectorAll('.usage-stat-item');
                    if (usageStatItems.length >= 1) {
                        const strong = usageStatItems[0].querySelector('strong');
                        if (strong) strong.textContent = `${profile.monthlyConversionCount || 0} / ${profile.maxMonthlyConversions || 1}`;
                        const fill = usageStatItems[0].querySelector('.usage-fill');
                        if (fill && profile.maxMonthlyConversions) {
                            fill.style.width = `${Math.min(100, ((profile.monthlyConversionCount || 0) / profile.maxMonthlyConversions) * 100)}%`;
                        }
                    }
                }
            } catch (err) {
                console.error('Error loading profile for settings:', err);
            }
        })();
    }

    // Wire "Upgrade Plan" and "Downgrade Plan" buttons to Stripe checkout
    const planActionBtns = document.querySelectorAll('.plan-actions .btn');
    planActionBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            if (typeof EbookVoiceAPI === 'undefined') return;
            const text = btn.textContent.trim().toLowerCase();
            if (text.includes('upgrade')) {
                try {
                    const result = await EbookVoiceAPI.createCheckoutSession('pro');
                    if (result.url) window.location.href = result.url;
                } catch (err) {
                    showNotification('Failed to start checkout');
                    console.error(err);
                }
            } else if (text.includes('downgrade') || text.includes('manage')) {
                try {
                    const result = await EbookVoiceAPI.createPortalSession();
                    if (result.url) window.location.href = result.url;
                } catch (err) {
                    showNotification('Failed to open billing portal');
                    console.error(err);
                }
            }
        });
    });

    // Wire "Update Payment Method" and "Cancel Subscription" to Stripe portal
    const updatePaymentBtn = document.getElementById('updatePaymentBtn');
    if (updatePaymentBtn) {
        updatePaymentBtn.addEventListener('click', async () => {
            if (typeof EbookVoiceAPI === 'undefined') return;
            try {
                const result = await EbookVoiceAPI.createPortalSession();
                if (result.url) window.location.href = result.url;
            } catch (err) {
                showNotification('Failed to open billing portal');
            }
        });
    }

    const cancelSubscriptionBtn = document.getElementById('cancelSubscriptionBtn');
    if (cancelSubscriptionBtn) {
        cancelSubscriptionBtn.addEventListener('click', async () => {
            if (typeof EbookVoiceAPI === 'undefined') return;
            try {
                const result = await EbookVoiceAPI.createPortalSession();
                if (result.url) window.location.href = result.url;
            } catch (err) {
                showNotification('Failed to open billing portal');
            }
        });
    }

    // Wire "Change Password" to Supabase
    const confirmPasswordBtn = document.getElementById('confirmPasswordBtn');
    if (confirmPasswordBtn) {
        confirmPasswordBtn.addEventListener('click', async () => {
            const newPwd = document.getElementById('newPassword').value;
            const confirmPwd = document.getElementById('confirmPassword').value;

            if (!newPwd || newPwd.length < 6) {
                showNotification('Password must be at least 6 characters');
                return;
            }
            if (newPwd !== confirmPwd) {
                showNotification('Passwords do not match');
                return;
            }

            try {
                const { error } = await supabaseClient.auth.updateUser({ password: newPwd });
                if (error) {
                    showNotification('Failed: ' + error.message);
                } else {
                    showNotification('Password changed successfully!');
                    const passwordModal = document.getElementById('passwordModal');
                    if (passwordModal) passwordModal.style.display = 'none';
                }
            } catch (err) {
                showNotification('Error changing password');
            }
        });
    }

    // Wire "Delete Account" to real API
    const realConfirmDeleteBtn = document.getElementById('confirmDeleteAccountBtn');
    if (realConfirmDeleteBtn) {
        // Enable button when user types DELETE
        const deleteConfirmText = document.getElementById('deleteConfirmText');
        if (deleteConfirmText) {
            deleteConfirmText.addEventListener('input', () => {
                realConfirmDeleteBtn.disabled = deleteConfirmText.value !== 'DELETE';
            });
        }

        realConfirmDeleteBtn.addEventListener('click', async () => {
            if (typeof EbookVoiceAPI === 'undefined') return;
            try {
                showNotification('Deleting account...');
                await EbookVoiceAPI.deleteAccount();
                await EbookVoiceAuth.signOut();
            } catch (err) {
                showNotification('Failed to delete account: ' + (err.message || ''));
                console.error(err);
            }
        });
    }

    // Check URL hash for initial section
    if (window.location.hash) {
        const sectionId = window.location.hash.substring(1);
        switchToSection(sectionId);
    } else {
        switchToSection('profile');
    }
}
