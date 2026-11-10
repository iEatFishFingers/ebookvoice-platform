/**
 * Ebook Voice - API Service (Vanilla JS)
 * Mirrors mobile-app/src/services/api.ts for the static web frontend.
 */

// ===================================
// Constants
// ===================================

// Configure by defining window.EBOOKVOICE_CONFIG before this script loads,
// e.g. in a small config.js: { apiUrl, supabaseUrl, supabaseAnonKey }.
const _CFG = window.EBOOKVOICE_CONFIG || {};
const API_BASE_URL = _CFG.apiUrl || 'http://localhost:8080';
const SUPABASE_URL = _CFG.supabaseUrl || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = _CFG.supabaseAnonKey || 'YOUR_SUPABASE_ANON_KEY';

// ===================================
// Supabase Client
// ===================================

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
    },
});

// ===================================
// Core Fetch Wrapper
// ===================================

/**
 * Authenticated fetch wrapper mirroring api.ts interceptors.
 * Auto-attaches Bearer token, retries once on 401 after refresh.
 */
async function apiFetch(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;

    // Timeout via AbortController (300s to match mobile)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    // Build headers
    const headers = { ...(options.headers || {}) };

    // Skip Content-Type for FormData (browser sets boundary automatically)
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }

    // Attach auth token
    try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error) {
            console.error('Supabase getSession error:', error);
        }
        if (session?.access_token) {
            headers['Authorization'] = `Bearer ${session.access_token}`;
        }
    } catch (err) {
        console.error('Error getting auth token:', err);
    }

    let response;
    try {
        response = await fetch(url, {
            ...options,
            headers,
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error('Request timed out');
        }
        throw err;
    }
    clearTimeout(timeoutId);

    // Handle 401 — refresh and retry once
    if (response.status === 401) {
        try {
            const { data: { session }, error: refreshError } = await supabaseClient.auth.refreshSession();

            if (refreshError || !session?.access_token) {
                console.error('Failed to refresh session');
                throw new Error('Authentication expired. Please sign in again.');
            }

            headers['Authorization'] = `Bearer ${session.access_token}`;

            const retryController = new AbortController();
            const retryTimeoutId = setTimeout(() => retryController.abort(), 300000);

            try {
                response = await fetch(url, {
                    ...options,
                    headers,
                    signal: retryController.signal,
                });
            } finally {
                clearTimeout(retryTimeoutId);
            }
        } catch (refreshErr) {
            console.error('Error during token refresh:', refreshErr);
            throw refreshErr;
        }
    }

    if (!response.ok) {
        let errorBody;
        try {
            errorBody = await response.json();
        } catch {
            errorBody = { error: response.statusText };
        }
        const err = new Error(errorBody.error || errorBody.message || `Request failed (${response.status})`);
        err.status = response.status;
        err.body = errorBody;
        throw err;
    }

    return response.json();
}

// ===================================
// API Methods — mirrors api.ts:123-527
// ===================================

const EbookVoiceAPI = {
    // ---------- Voices ----------
    async getVoices() {
        try {
            const data = await apiFetch('/api/voices');
            if (data && data.voices) {
                return data.voices;
            }
            return this._fallbackVoices();
        } catch (err) {
            console.error('Error fetching voices:', err);
            return this._fallbackVoices();
        }
    },

    _fallbackVoices() {
        return [
            { id: 'en-GB-SoniaNeural', name: 'Sonia (UK Female - Storytelling)', description: 'Natural British voice, perfect for storytelling', locale: 'en-GB', gender: 'Female', status: 'active' },
            { id: 'en-US-TonyNeural', name: 'Tony (US Male - Mature Narrator)', description: 'Deep, authoritative American voice', locale: 'en-US', gender: 'Male', status: 'active' },
            { id: 'en-US-DavisNeural', name: 'Davis (US Male - Smooth Narrator)', description: 'Smooth, professional narration', locale: 'en-US', gender: 'Male', status: 'active' },
            { id: 'en-US-AndrewNeural', name: 'Andrew (US Male - Expressive)', description: 'Dynamic and expressive delivery', locale: 'en-US', gender: 'Male', status: 'active' },
            { id: 'en-US-EmmaNeural', name: 'Emma (US Female - Cheerful)', description: 'Warm, friendly female voice', locale: 'en-US', gender: 'Female', status: 'active' },
        ];
    },

    getVoicePreviewUrl(voiceId) {
        return `${API_BASE_URL}/preview?voice=${encodeURIComponent(voiceId)}`;
    },

    // ---------- Conversion ----------
    async extractChapters(file) {
        const formData = new FormData();
        formData.append('file', file);
        const data = await apiFetch('/extract-chapters', {
            method: 'POST',
            body: formData,
        });
        return data.chapters;
    },

    async uploadAndConvert(file, voiceId) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('voice', voiceId);
        const data = await apiFetch('/convert', {
            method: 'POST',
            body: formData,
        });
        return { taskId: data.task_id, status: 'processing', progress: 5, complete: false };
    },

    async convertChapters(chapters, voiceId, title) {
        const data = await apiFetch('/convert-chapters', {
            method: 'POST',
            body: JSON.stringify({ chapters, voice: voiceId, title }),
        });
        return { taskId: data.task_id, status: 'processing', progress: 5, complete: false };
    },

    async convertText(text, voiceId) {
        const data = await apiFetch('/convert-text', {
            method: 'POST',
            body: JSON.stringify({ text, voice: voiceId }),
        });
        return { taskId: data.task_id, status: 'processing', progress: 5, complete: false };
    },

    // ---------- Status / Polling ----------
    async getConversionStatus(taskId) {
        const data = await apiFetch(`/status/${taskId}`);
        let audioUrl = data.audio_url;
        if (audioUrl && !audioUrl.startsWith('http')) {
            audioUrl = `${API_BASE_URL}${audioUrl}`;
        }
        return {
            taskId,
            status: data.status,
            progress: data.progress,
            audioUrl,
            error: data.error,
            complete: data.complete,
            chapters: data.chapters,
        };
    },

    /**
     * Poll conversion status at `intervalMs` (default 3s).
     * Calls `onProgress(status)` on each tick.
     * Resolves when complete, rejects on error.
     */
    pollConversionStatus(taskId, onProgress, intervalMs = 3000) {
        return new Promise((resolve, reject) => {
            const poll = async () => {
                try {
                    const status = await this.getConversionStatus(taskId);
                    if (onProgress) onProgress(status);

                    if (status.complete) {
                        resolve(status);
                    } else if (status.error) {
                        reject(new Error(status.error));
                    } else {
                        setTimeout(poll, intervalMs);
                    }
                } catch (err) {
                    reject(err);
                }
            };
            poll();
        });
    },

    // ---------- Library ----------
    async getLibrary() {
        const data = await apiFetch('/api/audiobooks');
        return data.audiobooks;
    },

    async updateProgress(audiobookId, currentPosition, currentChapter) {
        await apiFetch(`/api/audiobooks/${audiobookId}/progress`, {
            method: 'PUT',
            body: JSON.stringify({ currentPosition, currentChapter }),
        });
    },

    async deleteAudiobook(audiobookId) {
        await apiFetch(`/api/audiobooks/${audiobookId}`, {
            method: 'DELETE',
        });
    },

    // ---------- Profile ----------
    async getProfile() {
        const data = await apiFetch('/api/profile');
        return data.profile;
    },

    // ---------- Stripe ----------
    async createCheckoutSession(tier) {
        return apiFetch('/api/create-checkout-session', {
            method: 'POST',
            body: JSON.stringify({ tier }),
        });
    },

    async createPortalSession() {
        return apiFetch('/api/create-portal-session', {
            method: 'POST',
        });
    },

    // ---------- Account ----------
    async deleteAccount() {
        return apiFetch('/api/account', {
            method: 'DELETE',
        });
    },
};

// ===================================
// Auth Methods — mirrors AuthContext.tsx
// ===================================

const EbookVoiceAuth = {
    async signUp(email, password, firstName, lastName) {
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                data: {
                    first_name: firstName,
                    last_name: lastName,
                    display_name: `${firstName} ${lastName}`,
                },
            },
        });

        // If the user is already signed in (email confirmation disabled),
        // create their profile row now. When confirmation IS required, the
        // database trigger handle_new_user() creates the profile instead.
        if (!error && data?.session && data?.user) {
            try {
                await supabaseClient.from('profiles').upsert({
                    id: data.user.id,
                    email,
                    first_name: firstName,
                    last_name: lastName,
                    display_name: `${firstName} ${lastName}`,
                    subscription_tier: 'free',
                    max_audiobooks: 10,
                    max_monthly_conversions: 2,
                    monthly_conversion_count: 0,
                    conversion_count: 0,
                }, { onConflict: 'id', ignoreDuplicates: true });
            } catch (profileErr) {
                // Non-fatal: trigger will have already created it
                console.warn('Profile upsert skipped:', profileErr.message);
            }
        }

        return { data, error };
    },

    async signIn(email, password) {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password,
        });
        return { data, error };
    },

    async signInWithGoogle() {
        const redirectTo = `${window.location.origin}/auth.html`;
        const { data, error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo },
        });
        return { data, error };
    },

    async signOut() {
        const { error } = await supabaseClient.auth.signOut();
        if (!error) {
            window.location.href = 'index.html';
        }
        return { error };
    },

    onAuthStateChange(callback) {
        return supabaseClient.auth.onAuthStateChange(callback);
    },
};

// ===================================
// Helper Functions
// ===================================

/**
 * Redirect to auth.html if not authenticated.
 * Returns true if authenticated, false (and redirects) otherwise.
 */
async function requireAuth() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
        const currentPage = window.location.pathname.split('/').pop() || 'index.html';
        window.location.href = `auth.html?redirect=${encodeURIComponent(currentPage)}`;
        return false;
    }
    return true;
}

/**
 * Check authentication status without redirecting.
 */
async function isAuthenticated() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    return !!session;
}

/**
 * Get the current Supabase user object.
 */
async function getUser() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    return user;
}

/**
 * Update navbar user profile display across all pages.
 * Replaces hardcoded "John D." with real user data.
 */
async function updateNavbarProfile() {
    const userProfile = document.querySelector('.user-profile');
    if (!userProfile) return;

    const loggedIn = await isAuthenticated();
    if (!loggedIn) {
        // Replace user-profile with sign-in link
        userProfile.innerHTML = `
            <a href="auth.html" class="btn btn-primary btn-sm" style="text-decoration:none;">
                <i class="fas fa-sign-in-alt"></i> Sign In
            </a>
        `;
        return;
    }

    try {
        const user = await getUser();
        if (!user) return;

        const meta = user.user_metadata || {};
        const firstName = meta.first_name || meta.given_name || '';
        const lastName = meta.last_name || meta.family_name || '';
        const displayName = meta.display_name || meta.full_name || `${firstName} ${lastName}`.trim() || user.email;
        const initials = firstName && lastName
            ? `${firstName[0]}${lastName[0]}`
            : (displayName ? displayName.substring(0, 2) : 'U');
        const shortName = firstName
            ? `${firstName} ${lastName ? lastName[0] + '.' : ''}`
            : displayName.split(' ')[0];

        const avatarUrl = meta.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=6366f1&color=fff`;

        userProfile.innerHTML = `
            <img src="${avatarUrl}" alt="User Profile">
            <span class="user-name">${shortName}</span>
            <div class="user-dropdown" style="display:none; position:absolute; top:100%; right:0; background:var(--bg-card); border-radius:12px; box-shadow:var(--shadow-lg); padding:8px 0; min-width:180px; z-index:1000;">
                <a href="settings.html" style="display:block; padding:10px 16px; color:var(--text-primary); text-decoration:none; font-size:14px;">
                    <i class="fas fa-cog" style="margin-right:8px;"></i> Settings
                </a>
                <button id="navSignOutBtn" style="display:block; width:100%; text-align:left; padding:10px 16px; border:none; background:none; color:var(--text-primary); cursor:pointer; font-size:14px; font-family:inherit;">
                    <i class="fas fa-sign-out-alt" style="margin-right:8px;"></i> Sign Out
                </button>
            </div>
        `;

        // Toggle dropdown
        userProfile.style.position = 'relative';
        userProfile.style.cursor = 'pointer';

        const dropdown = userProfile.querySelector('.user-dropdown');

        userProfile.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        });

        document.addEventListener('click', () => {
            dropdown.style.display = 'none';
        });

        const signOutBtn = document.getElementById('navSignOutBtn');
        if (signOutBtn) {
            signOutBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await EbookVoiceAuth.signOut();
            });
        }
    } catch (err) {
        console.error('Error updating navbar profile:', err);
    }
}
