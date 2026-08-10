const root = document.querySelector("#root");
const appConfig = window.NEXAA_CONFIG;

if (!appConfig) {
  root.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;font-family:Inter,system-ui,sans-serif;background:#f7f7fb;color:#1b1b22">
      <section style="max-width:560px;border:1px solid #e3e3ec;border-radius:16px;padding:28px;background:white;box-shadow:0 18px 50px rgba(20,20,40,.08)">
        <h1 style="margin:0 0 10px;font-size:24px">Nexaa could not start</h1>
        <p style="margin:0;color:#666;line-height:1.6">The app configuration file did not load. Make sure <strong>js/app-config.js</strong> loads before <strong>js/script.js</strong>, then refresh the page.</p>
      </section>
    </main>
  `;
  throw new Error("Nexaa config missing: js/app-config.js must load before js/script.js");
}

const {
  ADMIN_SETTINGS_KEY,
  CREDIT_LINE,
  DATA_KEY,
  DEPARTMENT_NAME,
  GOOGLE_CLIENT_ID_PLACEHOLDER,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  PROFILE_BUCKET_KEY,
  TOUR_KEY,
  allowedUploadExtensions,
  defaultAdminSettings,
  defaultData,
  materials,
  maxUploadBytes,
  projects,
} = appConfig;

const initialPath = window.location.pathname.replace(/\/+$/, "");
const isRootEntryPath = initialPath === "/root";
const initialHash = isRootEntryPath ? "root" : window.location.hash.replace("#", "");
const GOOGLE_CLIENT_ID = document.querySelector("meta[name='google-signin-client_id']")?.content?.trim() || "";
const RECAPTCHA_SITE_KEY = window.NEXA_RECAPTCHA_SITE_KEY || localStorage.getItem("nexa-recaptcha-site-key") || document.querySelector("meta[name='recaptcha-site-key']")?.content?.trim() || "";
const SAVED_RESOURCES_KEY = "nexaa-saved-resources";
const LOGIN_COUNT_KEY = "nexaa-login-count";
const ROOT_SESSION_KEY = "nexaa-root-session";
const SUPPORT_ADMIN_EMAIL = "admin.nexaa@gmail.com";
const STAFF_VERIFICATION_PHRASE = "DEMO";
const DEFAULT_API_BASE_URL = "";
const realtimeChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("nexaa-realtime") : null;
let supabaseClient = null;
let supabaseChannels = [];
let supabaseSetupTimer = null;
let supabaseRealtimeUnavailable = false;
let supabaseRealtimeSettingUp = false;
let supabaseRealtimeKey = "";
let studentArchiveTimer = null;
let studentArchiveRetryAt = 0;
let adminOverviewTimer = null;
let supportInboxTimer = null;
let securityCenterTimer = null;
let lastCommittedMarkup = "";
const baseDevicePixelRatio = window.devicePixelRatio || 1;
const desktopZoomLock = window.matchMedia("(hover: hover) and (pointer: fine)");
const hashParams = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "");
const incomingResetToken = new URLSearchParams(window.location.search).get("reset_token") || "";
const incomingRecoveryAccessToken = hashParams.get("access_token") || "";
const incomingRecoveryRefreshToken = hashParams.get("refresh_token") || "";
const incomingRecoveryType = hashParams.get("type") || "";
const isEmailConfirmationRedirect = incomingRecoveryType === "signup";
const isPasswordRecoveryRedirect = Boolean(incomingResetToken || incomingRecoveryType === "recovery");

localStorage.removeItem("nexaa-demo-credentials");
localStorage.removeItem("nexaa-reset-auth");
localStorage.removeItem("nexaa-session");

function currentPathIsRoot() {
  return window.location.pathname.replace(/\/+$/, "") === "/root";
}

function isRootUserRecord(user) {
  const raw = String(user?.role || user?.title || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return Boolean(user?.superAdmin || raw === "super_admin" || raw === "root");
}

function readRootSession() {
  try {
    return JSON.parse(sessionStorage.getItem(ROOT_SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function rootSessionActive() {
  const session = readRootSession();
  return Boolean(session?.email && Number(session.expiresAt || 0) > Date.now());
}

function writeRootSession(email) {
  sessionStorage.setItem(ROOT_SESSION_KEY, JSON.stringify({
    email: String(email || "").trim().toLowerCase(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 1000 * 60 * 60 * 6,
  }));
}

function clearRootSession() {
  sessionStorage.removeItem(ROOT_SESSION_KEY);
}

function readStoredUser() {
  try {
    const user = JSON.parse(localStorage.getItem("nexaa-user") || "null");
    if (isRootUserRecord(user) && (!currentPathIsRoot() || !rootSessionActive())) {
      localStorage.removeItem("nexaa-user");
      sessionStorage.removeItem("nexaa-session");
      clearRootSession();
      return null;
    }
    return user;
  } catch {
    localStorage.removeItem("nexaa-user");
    return null;
  }
}

// Browser persistence stores UI state only; auth and account flows must use the backend.
function readData() {
  try {
    return normalizeData({ ...defaultData, ...JSON.parse(localStorage.getItem(DATA_KEY) || "{}") });
  } catch (error) {
    return normalizeData({ ...defaultData });
  }
}

function writeData(nextData) {
  const normalized = normalizeData(nextData);
  const serialized = JSON.stringify(normalized);
  localStorage.setItem(DATA_KEY, serialized);
  lastDataSignature = serialized;
  realtimeChannel?.postMessage({ type: "data:update", at: Date.now() });
}

function normalizeData(data) {
  const next = { ...defaultData, ...data };
  ["users", "activity", "uploads", "staffIds", "supportRequests", "institutions", "faculties", "departments", "programmes"].forEach((key) => {
    if (!Array.isArray(next[key]) || next[key].length === 0) next[key] = [...defaultData[key]];
  });
  next.users = next.users.filter((item) => !String(item.id || "").startsWith("are-"));
  next.activity = next.activity.filter((item) => !String(item.id || "").startsWith("act-"));
  next.uploads = next.uploads.filter((item) => !String(item.id || "").startsWith("upl-"));
  next.staffIds = next.staffIds.filter((item) => !String(item.id || "").startsWith("sid-"));
  next.pendingReviews = next.uploads.filter((item) => item.status === "Pending Review").length;
  return next;
}

let appData = readData();
let adminSettings = readAdminSettings();
let lastDataSignature = localStorage.getItem(DATA_KEY) || "";
let profileRefreshRequested = false;
let bookmarkToastTimer = null;
let authErrorTimer = null;
let resetErrorTimer = null;

const errorMessages = {
  signup: {
    missingCredentials: "Please enter both your email and password.",
    passwordTooShort: "Your password must be at least 8 characters long.",
    emailExists: "An account already exists with this email. Try logging in instead.",
    emailCheckFailed: "We could not verify this email right now. Please try again.",
    recaptchaLoading: "Security check is still loading. Please wait a moment.",
    recaptchaMissing: "Please complete the security verification before continuing.",
    recaptchaFailed: "Security verification failed. Please try again.",
    otpSendFailed: "We could not send your verification code. Please try again.",
    otpExpired: "This verification code has expired. Request a new one.",
    otpIncorrect: "The verification code you entered is incorrect.",
    accountCreationFailed: "We could not create your account right now. Please try again later.",
    emailConfirmationRequired: "Please confirm your email before signing in.",
    futaStaffEmailRequired: "Only valid FUTA staff email addresses can register as staff or admin.",
  },
  login: {
    missingCredentials: "Please enter your email and password.",
    invalidCredentials: "Incorrect email or password. Please try again.",
    backendUnavailable: "The server is currently unavailable. Please try again later.",
    pendingApproval: "Your account is still awaiting approval from the administrator.",
    suspended: "Your account has been suspended. Contact support for assistance.",
    sessionExpired: "Your session has expired. Please log in again.",
    profileLoadFailed: "We could not load your profile right now.",
  },
  google: {
    generic: "Google sign in failed. Please try again.",
    cancelled: "Google sign in was cancelled before completion.",
    network: "A network error occurred. Check your internet connection and try again.",
    permission: "Required permissions were not granted.",
    accountExists: "An account already exists with this email. Try logging in another way.",
    oauthConfig: "Authentication setup is incomplete. Contact support if this continues.",
    scriptMissing: "Google services could not load properly. Refresh the page and try again.",
  },
  reset: {
    missingEmail: "Please enter the email linked to your account.",
    linkSendFailed: "We could not send the password reset link. Please try again.",
    linkExpired: "This password reset link has expired. Request a new one.",
    passwordTooShort: "Your new password must be at least 8 characters long.",
    passwordMismatch: "Passwords do not match. Please confirm your password again.",
    updateFailed: "We could not update your password right now.",
  },
  profile: {
    missingStudentName: "Please enter your full name.",
    missingMatricNumber: "Please enter your matric number.",
    missingLevel: "Please select your current level.",
    missingStaffName: "Please enter your full name.",
    missingStaffEmail: "Please enter a valid FUTA staff email address.",
    missingStaffId: "Please enter your staff or admin ID.",
    staffRequestFailed: "We could not submit your request right now. Please try again later.",
    pendingApproval: "Your request has been submitted and is awaiting approval.",
  },
  uploads: {
    notStaff: "Only approved staff or admins can upload files.",
    invalidType: "This file type is not supported.",
    tooLarge: "This file exceeds the allowed upload size.",
    missingMetadata: "Some required upload information is missing.",
    failed: "File upload failed. Please try again.",
    viewerFailed: "We could not open the protected file viewer.",
    pageFailed: "This protected page could not be loaded.",
  },
  saved: {
    saveFailed: "We could not save this item right now.",
    removeFailed: "We could not remove this item from your saved library.",
    loadFailed: "Your saved items could not be loaded.",
  },
  archive: {
    unavailable: "The archive is temporarily unavailable.",
    noResults: "No matching projects or materials were found.",
    detailsUnavailable: "We could not load the selected project or material.",
  },
  notifications: {
    loadFailed: "Notifications could not be loaded right now.",
    sendFailed: "We could not send the notification.",
    realtimeUnavailable: "Live updates are currently unavailable.",
  },
  maintenance: {
    active: "The system is currently under maintenance. Please check back later.",
    updateFailed: "We could not update maintenance settings right now.",
    locked: "The system is temporarily restricted by the administrator.",
  },
  support: {
    authRequired: "Please create an account or log in to continue.",
    missingFields: "Please complete all required support fields before submitting.",
    sendFailed: "Your support message could not be sent.",
    gmailNotConfigured: "Email support is not fully configured yet.",
  },
  general: {
    backendOffline: "The server is currently offline.",
    missingResource: "A required database resource could not be found.",
    networkOffline: "You appear to be offline. Check your internet connection.",
    rateLimited: "Too many attempts detected. Please wait a moment before trying again.",
    unexpected: "Something unexpected happened. Please try again later.",
  },
};

// Single source of truth for the current screen, auth forms, filters, modals, and walkthrough state.
const state = {
  route: isEmailConfirmationRedirect ? "login" : initialHash || "home",
  authMode: "login",
  authStep: "credentials",
  authFlipClass: "",
  authSubmitting: "",
  bannerIndex: 0,
  bannerCycleStartedAt: Date.now(),
  showPassword: false,
  rootAuthStep: "password",
  rootEmail: "",
  rootPassword: "",
  rootSecretPhrase: "",
  rootStepMotion: "",
  rootRecoverOpen: false,
  rootRecoverEmail: "",
  isStaff: false,
  profileRole: "student",
  user: readStoredUser(),
  session: JSON.parse(sessionStorage.getItem("nexaa-session") || "null"),
  email: "",
  password: "",
  signupOtp: "",
  signupOtpInput: "",
  signupOtpDelivery: "",
  signupAccessToken: "",
  signupRefreshToken: "",
  signupOtpResends: 0,
  signupOtpCooldownUntil: 0,
  signupOtpResending: false,
  recaptchaToken: "",
  googleProfile: null,
  googleAccessToken: "",
  googleCredential: "",
  googlePendingProfile: null,
  googleAuthInProgress: false,
  googleAuthCooldownUntil: 0,
  firstName: "",
  lastName: "",
  staffFullName: "",
  staffId: "",
  staffEmail: "",
  matricNumber: "",
  adminScope: "",
  studentLevel: "100L",
  staffTitle: "",
  search: "",
  adminView: "overview",
  adminPanelTab: "users",
  workCategory: "FYP",
  materialLevel: "",
  materialType: "",
  materialCourseCode: "",
  viewMode: "grid",
  projectSort: "newest",
  contentType: "All Types",
  uploadMode: "project",
  uploadMaterialType: "PDF",
  uploadFile: null,
  uploadError: "",
  uploadSubmitting: false,
  uploadNotice: "",
  lecturerView: "overview",
  menuOpen: false,
  adminSearch: "",
  sentinelView: "overview",
  sentinelMode: "normal",
  sentinelExpandedLog: "",
  searchYear: "All Years",
  searchLevel: "All Levels",
  searchMaterialType: "All Types",
  notificationOpen: false,
  helpOpen: false,
  helpSent: false,
  resetOpen: false,
  resetMethod: "otp",
  resetStep: isPasswordRecoveryRedirect ? "new-password" : "request",
  resetSent: false,
  resetEmail: "",
  resetOtp: "",
  resetOtpInput: "",
  resetToken: incomingResetToken,
  resetAccessToken: isPasswordRecoveryRedirect ? incomingRecoveryAccessToken : "",
  resetRefreshToken: isPasswordRecoveryRedirect ? incomingRecoveryRefreshToken : "",
  resetLink: incomingResetToken ? window.location.href : "",
  resetDelivery: "",
  resetError: "",
  resetPassword: "",
  resetConfirm: "",
  authError: isEmailConfirmationRedirect ? "Email confirmed. Sign in with your email and password to continue." : "",
  googleAuthReady: false,
  bookmarkToast: null,
  protectedViewerId: "",
  protectedViewerLoading: false,
  protectedViewerError: "",
  protectedViewerDocument: null,
  protectedViewerPage: 1,
  protectedViewerPageLoading: false,
  protectedViewerPageImageUrl: "",
  liveArchive: {
    loaded: false,
    loading: false,
    error: "",
    projects: [],
    materials: [],
    savedIds: [],
    notifications: [],
  },
  liveStaff: {
    loaded: false,
    loading: false,
    error: "",
    uploads: [],
    staff: [],
  },
  liveAdmin: {
    loaded: false,
    loading: false,
    error: "",
    stats: null,
    users: [],
    staffIds: [],
    uploads: [],
    notifications: [],
    rootSettings: null,
  },
  liveSupport: {
    loaded: false,
    loading: false,
    error: "",
    requests: [],
    replying: "",
  },
  liveSecurity: {
    loaded: false,
    loading: false,
    error: "",
    status: null,
    metrics: null,
    logs: [],
    alerts: [],
    threats: [],
    monitoring: null,
    backups: [],
    settings: null,
  },
  tourActive: false,
  tourStep: 0,
  appBooting: true,
  pageLoading: false,
  loaderMessage: "Preparing your archive",
};

localStorage.removeItem("nexaa-session");

function readAdminSettings() {
  try {
    return { ...defaultAdminSettings, ...JSON.parse(localStorage.getItem(ADMIN_SETTINGS_KEY) || "{}") };
  } catch (error) {
    return { ...defaultAdminSettings };
  }
}

function writeAdminSettings(nextSettings) {
  adminSettings = { ...defaultAdminSettings, ...nextSettings };
  localStorage.setItem(ADMIN_SETTINGS_KEY, JSON.stringify(adminSettings));
}

function scheduleAuthErrorAutoClear() {
  window.clearTimeout(authErrorTimer);
  if (!state.authError || state.resetOpen) return;
  const visibleError = state.authError;
  authErrorTimer = window.setTimeout(() => {
    if (state.authError !== visibleError) return;
    state.authError = "";
    render();
  }, 5200);
}

function setResetError(message = "") {
  window.clearTimeout(resetErrorTimer);
  state.resetError = message;
  if (!message) return;
  const visibleError = message;
  resetErrorTimer = window.setTimeout(() => {
    if (state.resetError !== visibleError) return;
    state.resetError = "";
    render();
  }, 5200);
}

function localRoleToSupabaseRole(role = roleSlug()) {
  return String(role || "student")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function supabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && window.supabase?.createClient);
}

function getSupabaseClient() {
  // The browser client uses only the publishable key; privileged writes go through the backend.
  if (!supabaseConfigured()) return null;
  if (!supabaseClient) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return supabaseClient;
}

function rememberAdminSettings(nextSettings) {
  adminSettings = { ...defaultAdminSettings, ...nextSettings };
  localStorage.setItem(ADMIN_SETTINGS_KEY, JSON.stringify(adminSettings));
}

async function syncSupabaseSession() {
  // Realtime channels need the latest user token so RLS can filter notifications correctly.
  const client = getSupabaseClient();
  if (!client) return null;
  if (state.session?.access_token && state.session?.refresh_token) {
    try {
      await client.auth.setSession({
        access_token: state.session.access_token,
        refresh_token: state.session.refresh_token,
      });
      client.realtime?.setAuth?.(state.session.access_token);
    } catch {
      client.realtime?.setAuth?.(state.session.access_token);
    }
  } else if (state.session?.access_token) {
    client.realtime?.setAuth?.(state.session.access_token);
  }
  return client;
}

function mapRemoteNotification(row) {
  return {
    id: row.id,
    targetRole: row.target_role || "all",
    targetUserId: row.target_user_id || "",
    title: row.title || "Nexaa update",
    body: row.body || "",
    at: row.created_at || new Date().toISOString(),
  };
}

function mergeRemoteNotifications(rows = []) {
  let changed = false;
  rows.forEach((row) => {
    changed = mergeRemoteNotification(row) || changed;
  });
  return changed;
}

function notificationMatchesCurrentUser(note) {
  if (!state.user) return false;
  const role = localRoleToSupabaseRole();
  return note.targetRole === "all" || note.targetRole === role || note.targetUserId === state.user.id;
}

function mergeRemoteNotification(row) {
  const note = mapRemoteNotification(row);
  if (!notificationMatchesCurrentUser(note)) return false;
  const existing = adminSettings.notifications || [];
  if (existing.some((item) => item.id === note.id)) return false;
  rememberAdminSettings({
    ...adminSettings,
    notifications: [note, ...existing].slice(0, 40),
  });
  return true;
}

function isMissingSupabaseTable(error) {
  const text = String(error?.message || error?.details || error?.hint || error?.code || error || "").toLowerCase();
  return error?.code === "42P01" || text.includes("does not exist") || text.includes("not found") || text.includes("404");
}

async function loadRemoteMaintenanceState(client) {
  try {
    const { data, error } = await client
      .from("maintenance_state")
      .select("enabled,message,updated_at")
      .eq("id", true)
      .maybeSingle();
    if (error) {
      if (isMissingSupabaseTable(error)) supabaseRealtimeUnavailable = true;
      return;
    }
    if (!data) return;
    rememberAdminSettings({
      ...adminSettings,
      maintenanceEnabled: Boolean(data.enabled),
      maintenanceMessage: data.message || defaultAdminSettings.maintenanceMessage,
    });
  } catch (error) {
    if (isMissingSupabaseTable(error)) supabaseRealtimeUnavailable = true;
  }
}

async function loadRemoteNotifications(client) {
  if (!state.user) return;
  try {
    const { data, error } = await client
      .from("notifications")
      .select("id,title,body,target_role,target_user_id,created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) {
      if (isMissingSupabaseTable(error)) supabaseRealtimeUnavailable = true;
      return;
    }
    if (!Array.isArray(data)) return;
    const changed = mergeRemoteNotifications(data.reverse());
    if (changed) render();
  } catch (error) {
    if (isMissingSupabaseTable(error)) supabaseRealtimeUnavailable = true;
    // RLS may deny reads until the logged-in Supabase session is configured.
  }
}

async function refreshNotifications() {
  if (!state.user) return;
  const client = await syncSupabaseSession();
  if (client && !supabaseRealtimeUnavailable) await loadRemoteNotifications(client);
  if (state.session?.access_token && roleKey() === "student") {
    await loadStudentArchive({ force: true });
  }
  if (state.session?.access_token && hasAdminAccess()) {
    await loadAdminOverview({ force: true });
    if (isSuperAdmin()) await loadSecurityCenter({ force: true });
  }
  render();
}

async function removeSupabaseChannels() {
  const client = getSupabaseClient();
  if (client) await Promise.allSettled(supabaseChannels.map((channel) => client.removeChannel(channel)));
  supabaseChannels = [];
  supabaseRealtimeKey = "";
}

async function setupSupabaseRealtime() {
  // Subscriptions keep maintenance and notifications live across open browser tabs.
  if (supabaseRealtimeSettingUp) return;
  const client = await syncSupabaseSession();
  if (!client || supabaseRealtimeUnavailable) return;
  const nextKey = `${state.user?.email || "guest"}:${state.session?.access_token ? "session" : "public"}`;
  if (supabaseRealtimeKey === nextKey && supabaseChannels.length) return;
  supabaseRealtimeSettingUp = true;
  try {
    await removeSupabaseChannels();
    await loadRemoteMaintenanceState(client);
    await loadRemoteNotifications(client);
    if (supabaseRealtimeUnavailable) return;

    const channelSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const maintenance = client
      .channel(`nexaa-maintenance-${channelSuffix}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "maintenance_state" }, (payload) => {
        rememberAdminSettings({
          ...adminSettings,
          maintenanceEnabled: Boolean(payload.new?.enabled),
          maintenanceMessage: payload.new?.message || defaultAdminSettings.maintenanceMessage,
        });
        render();
      })
      .subscribe();
    supabaseChannels.push(maintenance);

    if (state.user) {
      const notifications = client
        .channel(`nexaa-notifications-${userStorageId()}-${channelSuffix}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
          if (mergeRemoteNotification(payload.new)) {
            state.notificationOpen = true;
            render();
          }
        })
        .subscribe();
      supabaseChannels.push(notifications);
    }
    supabaseRealtimeKey = nextKey;
  } catch (error) {
    console.warn("Realtime setup skipped:", error?.message || error);
  } finally {
    supabaseRealtimeSettingUp = false;
  }
}

function scheduleSupabaseRealtimeSetup() {
  if (supabaseSetupTimer) window.clearTimeout(supabaseSetupTimer);
  supabaseSetupTimer = window.setTimeout(setupSupabaseRealtime, 120);
}

async function pushMaintenanceToSupabase() {
  await apiRequest("/api/maintenance", {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({
      enabled: Boolean(adminSettings.maintenanceEnabled),
      message: adminSettings.maintenanceMessage || defaultAdminSettings.maintenanceMessage,
    }),
  });
}

async function pushNotificationToSupabase(note) {
  if (!note) return;
  await apiRequest("/api/notifications", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      title: note.title,
      body: note.body,
      targetRole: note.targetRole,
    }),
  });
}

if (isPasswordRecoveryRedirect) {
  state.route = "login";
  state.authMode = "login";
  state.resetOpen = true;
  state.resetMethod = "otp";
  state.resetDelivery = "";
}

if (isEmailConfirmationRedirect) {
  state.route = "login";
  state.authMode = "login";
  state.resetOpen = false;
  window.setTimeout(() => {
    showStatusToast("Email confirmed. You can sign in now.", "Nexaa account", true);
    window.history.replaceState(null, "", `${window.location.pathname}#login`);
  }, 300);
}

const lucideIcon = (name, body) =>
  `<svg class="lucide lucide-${name}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">${body}</svg>`;

const googleLogo = `<svg class="google-logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z"/><path fill="#FBBC05" d="M10.53 28.59A14.45 14.45 0 0 1 9.75 24c0-1.59.28-3.14.78-4.59l-7.98-6.19A23.93 23.93 0 0 0 0 24c0 3.85.92 7.48 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.97 6.19C6.51 42.62 14.62 48 24 48Z"/><path fill="none" d="M0 0h48v48H0z"/></svg>`;

const icons = {
  archive: lucideIcon("archive", `<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>`),
  login: lucideIcon("log-in", `<path d="m10 17 5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>`),
  userPlus: lucideIcon("user-plus", `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>`),
  search: lucideIcon("search", `<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>`),
  book: lucideIcon("book-open", `<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>`),
  file: lucideIcon("file-text", `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`),
  spark: lucideIcon("sparkles", `<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>`),
  eye: lucideIcon("eye", `<path d="M2.06 12.35a1 1 0 0 1 0-.7C3.42 7.5 7.35 5 12 5s8.58 2.5 9.94 6.65a1 1 0 0 1 0 .7C20.58 16.5 16.65 19 12 19s-8.58-2.5-9.94-6.65"/><circle cx="12" cy="12" r="3"/>`),
  eyeOff: lucideIcon("eye-off", `<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.65 0 8.58 2.5 9.94 6.65a1 1 0 0 1 0 .7 10.5 10.5 0 0 1-1.2 2.3"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-4.65 0-8.58-2.5-9.94-6.65a1 1 0 0 1 0-.7A10.5 10.5 0 0 1 6.06 6.06"/><line x1="2" x2="22" y1="2" y2="22"/>`),
  trending: lucideIcon("trending-up", `<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>`),
  logout: lucideIcon("log-out", `<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>`),
  users: lucideIcon("users", `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>`),
  userCircle: lucideIcon("circle-user-round", `<path d="M18 20a6 6 0 0 0-12 0"/><circle cx="12" cy="10" r="4"/><circle cx="12" cy="12" r="10"/>`),
  staff: lucideIcon("id-card", `<path d="M16 10h2"/><path d="M16 14h2"/><path d="M6.17 15a3 3 0 0 1 5.66 0"/><circle cx="9" cy="11" r="2"/><rect x="2" y="5" width="20" height="14" rx="2"/>`),
  shield: lucideIcon("shield-check", `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>`),
  lock: lucideIcon("lock-keyhole", `<circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>`),
  clock: lucideIcon("clock-3", `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16.5 12"/>`),
  upload: lucideIcon("upload", `<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>`),
  download: lucideIcon("download", `<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>`),
  refresh: lucideIcon("refresh-cw", `<path d="M3 12a9 9 0 0 1 15.17-6.47L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.17 6.47L3 16"/><path d="M3 21v-5h5"/>`),
  terminal: lucideIcon("terminal", `<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>`),
  expand: lucideIcon("expand", `<path d="m21 21-6-6m6 6v-4.8m0 4.8h-4.8"/><path d="M3 16.2V21m0 0h4.8M3 21l6-6"/><path d="M21 7.8V3m0 0h-4.8M21 3l-6 6"/><path d="M3 7.8V3m0 0h4.8M3 3l6 6"/>`),
  cap: lucideIcon("graduation-cap", `<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>`),
  clipboard: lucideIcon("clipboard-list", `<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>`),
  briefcase: lucideIcon("briefcase-business", `<path d="M12 12h.01"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M22 13a18.15 18.15 0 0 1-20 0"/><rect width="20" height="14" x="2" y="6" rx="2"/>`),
  mic: lucideIcon("mic", `<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>`),
  grid: lucideIcon("layout-grid", `<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>`),
  list: lucideIcon("list", `<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>`),
  rows: lucideIcon("rows-3", `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M21 9H3"/><path d="M21 15H3"/>`),
  sort: lucideIcon("arrow-down-up", `<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>`),
  filter: lucideIcon("funnel", `<path d="M10 20a1 1 0 0 0 .55.9l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>`),
  bookmark: lucideIcon("bookmark", `<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>`),
  check: lucideIcon("check", `<path d="M20 6 9 17l-5-5"/>`),
  menu: lucideIcon("menu", `<path d="M4 12h16"/><path d="M4 18h16"/><path d="M4 6h16"/>`),
  x: lucideIcon("x", `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`),
  arrowRight: lucideIcon("arrow-right", `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`),
  chevronDown: lucideIcon("chevron-down", `<path d="m6 9 6 6 6-6"/>`),
  bell: lucideIcon("bell", `<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.674C19.41 13.956 18 12.499 18 8a6 6 0 0 0-12 0c0 4.499-1.411 5.956-2.738 7.326"/>`),
  mail: lucideIcon("mail", `<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a2 2 0 0 1-2.06 0L2 7"/>`),
  settings: lucideIcon("settings", `<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>`),
  library: lucideIcon("library", `<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>`),
  alert: lucideIcon("circle-alert", `<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>`),
};

const banners = [
  {
    image: "/images/login-banner-1.jpg",
    title: "Explore the Archive",
    subtitle: "Thousands of academic projects preserved and searchable.",
    icon: icons.archive,
  },
  {
    image: "/images/login-banner-2.jpg",
    title: "Organized Knowledge",
    subtitle: "Every document catalogued, indexed, and accessible.",
    icon: icons.book,
  },
  {
    image: "/images/login-banner-3.jpg",
    title: "Collaborate & Grow",
    subtitle: "Join a community of scholars building the future.",
    icon: icons.book,
  },
];

const BANNER_CYCLE_MS = 6200;

function setBannerIndex(index, { resetCycle = true, updateDom = true } = {}) {
  const nextIndex = ((Number(index) % banners.length) + banners.length) % banners.length;
  state.bannerIndex = nextIndex;
  if (resetCycle) state.bannerCycleStartedAt = Date.now();
  if (updateDom) requestAnimationFrame(() => updateAuthBannerDom({ preserveCycle: !resetCycle }));
}

function updateAuthBannerDom({ preserveCycle = true } = {}) {
  const media = document.querySelector(".auth-media");
  const copy = document.querySelector(".slide-copy");
  const dots = [...document.querySelectorAll(".slide-dots button")];
  if (!media || !copy || !dots.length) return;

  const banner = banners[state.bannerIndex] || banners[0];

  // Restart the auth media fade animation on each banner update so image changes feel smooth.
  media.style.animation = "none";
  requestAnimationFrame(() => {
    media.style.setProperty("--banner-image", `url('${banner.image}')`);
    media.style.animation = "auth-image-in 0.75s ease both";
  });

  const icon = copy.querySelector(".slide-icon");
  const heading = copy.querySelector("h1");
  const subtitle = copy.querySelector("p");
  if (icon) icon.innerHTML = banner.icon;
  if (heading) heading.textContent = banner.title;
  if (subtitle) subtitle.textContent = banner.subtitle;

  const elapsed = preserveCycle
    ? Math.min(Math.max(Date.now() - Number(state.bannerCycleStartedAt || Date.now()), 0), BANNER_CYCLE_MS)
    : 0;

  dots.forEach((dot, index) => {
    dot.classList.toggle("active", index === state.bannerIndex);
    dot.style.setProperty("--banner-progress-delay", index === state.bannerIndex ? `-${elapsed}ms` : "0ms");
  });
}

function persistRoute(route) {
  state.route = route;
  state.menuOpen = false;
  localStorage.setItem("nexaa-route", route);
  if (isRootUserRecord(state.user) && rootSessionActive() && ["admin", "sentinel", "settings"].includes(route)) {
    if (!currentPathIsRoot() || window.location.hash) {
      history.replaceState(null, "", "/root");
    }
    return;
  }
  if (route === "root") {
    if (window.location.pathname !== "/root" || window.location.hash) {
      history.replaceState(null, "", "/root");
    }
    return;
  }
  if (window.location.pathname === "/root") {
    history.replaceState(null, "", `${window.location.origin}${window.location.search}#${route}`);
    return;
  }
  if (window.location.hash.replace("#", "") !== route) {
    history.replaceState(null, "", `#${route}`);
  }
}

function clearCredentialFields() {
  state.email = "";
  state.password = "";
  state.signupOtp = "";
  state.signupOtpInput = "";
  state.signupOtpDelivery = "";
  state.signupAccessToken = "";
  state.signupRefreshToken = "";
  state.signupOtpResends = 0;
  state.signupOtpCooldownUntil = 0;
  state.signupOtpResending = false;
  state.recaptchaToken = "";
  state.googleProfile = null;
  state.googleAccessToken = "";
  state.googleCredential = "";
  state.googlePendingProfile = null;
  state.googleAuthInProgress = false;
  state.googleAuthCooldownUntil = 0;
  state.authError = "";
}

function clearAuthDraftFields() {
  clearCredentialFields();
  state.firstName = "";
  state.lastName = "";
  state.staffId = "";
  state.staffEmail = "";
  state.matricNumber = "";
  state.rootAuthStep = "password";
  state.rootEmail = "";
  state.rootPassword = "";
  state.rootSecretPhrase = "";
  state.rootStepMotion = "";
  state.rootRecoverOpen = false;
  state.rootRecoverEmail = "";
  state.adminScope = "";
  state.studentLevel = "100L";
  state.staffTitle = "";
  state.resetEmail = "";
  state.resetOtpInput = "";
}

function navigate(route) {
  const previousRoute = state.route;
  const changedRoute = previousRoute !== route;
  if (route === "login") {
    clearAuthDraftFields();
    state.authStep = "credentials";
  }
  state.pageLoading = false;
  persistRoute(route);
  if (route === "sentinel") state.adminView = "security-center";
  else if (route === "admin") state.adminView = "overview";
  else state.adminView = "overview";
  render({ animated: changedRoute });
  if (changedRoute) {
    window.setTimeout(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 0);
  }
}

function roleKey(user = state.user) {
  const raw = String(user?.role || user?.title || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (user?.superAdmin || raw === "super_admin" || raw === "root") return "super_admin";
  if (user?.hod) return "hod";
  const title = String(user?.title || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "hod" || raw === "head_of_department") return "hod";
  if (raw === "admin") return "admin";
  if (title === "hod" || title === "head_of_department") return "hod";
  if (raw === "staff" || raw === "lecturer" || raw === "teacher") return "staff";
  if (user?.staffId || title === "lecturer" || title === "staff" || title === "teacher") return "staff";
  return "student";
}

function displayRole(user = state.user) {
  const key = roleKey(user);
  if (key === "super_admin") return "Super Admin";
  if (key === "hod") return "HOD";
  if (key === "admin") return "Admin";
  if (key === "staff") return "Staff";
  return "Student";
}

function isSuperAdmin() {
  return Boolean(roleKey() === "super_admin" && currentPathIsRoot() && rootSessionActive());
}

function isRegularAdmin() {
  return Boolean(roleKey() === "admin");
}

function hasAdminAccess() {
  const key = roleKey();
  if (key === "super_admin") return isSuperAdmin();
  return Boolean(key === "admin" && state.user?.status !== "pending" && state.user?.status !== "suspended");
}

function hasStaffAccess() {
  const key = roleKey();
  if (key === "super_admin") return isSuperAdmin();
  return Boolean(["staff", "hod", "admin"].includes(key) && state.user?.status !== "pending" && state.user?.status !== "suspended");
}

function hasStaffWorkspaceAccess() {
  return Boolean(["staff", "hod"].includes(roleKey()) && state.user?.status !== "pending" && state.user?.status !== "suspended");
}

function isAdminShellTarget(target) {
  if (!target) return false;
  return Boolean(target.closest(".admin-shell, .site-header, .mobile-drawer"));
}

function isLecturerShellTarget(target) {
  if (!target) return false;
  return Boolean(target.closest(".lecturer-shell"));
}

function isPendingApproval(user = state.user) {
  return Boolean(user && user.status === "pending" && ["staff", "admin"].includes(roleKey(user)));
}

function canManageStaff() {
  return Boolean((roleKey() === "hod" || isSuperAdmin()) && state.user?.status !== "pending" && state.user?.status !== "suspended");
}

function currentName() {
  if (state.user?.name) return state.user.name;
  return `${state.firstName} ${state.lastName}`.trim() || "Nexaa User";
}

function userStorageId() {
  return String(state.user?.email || state.email || "guest").trim().toLowerCase();
}

function loginCountKey(user = state.user) {
  const email = String(user?.email || state.email || "guest").trim().toLowerCase();
  return `${LOGIN_COUNT_KEY}:${email}`;
}

function loginCountForUser(user = state.user) {
  return Number(localStorage.getItem(loginCountKey(user)) || 0);
}

function recordLogin(user = state.user) {
  if (!user?.email) return;
  const key = loginCountKey(user);
  localStorage.setItem(key, String(loginCountForUser(user) + 1));
}

function shouldShowTourButton() {
  return false;
}

function tourStartButton() {
  return shouldShowTourButton()
    ? `<button class="tour-start" data-action="restartTour">${icons.spark}<span>Tour</span></button>`
    : "";
}

function userTourKey() {
  return `${TOUR_KEY}:${roleSlug()}:${userStorageId()}`;
}

function roleSlug() {
  const key = roleKey();
  if (key === "super_admin") return "super-admin";
  return key;
}

const roleDefinitions = {
  student: {
    label: "Student",
    summary: "Discover, save, and request academic resources.",
    functions: ["Browse approved projects", "View materials by level", "Save resources for later"],
  },
  staff: {
    label: "Staff",
    summary: "Submit academic resources and track review status.",
    functions: ["Upload projects and materials", "Track approval status", "Manage own submissions"],
  },
  hod: {
    label: "HOD",
    summary: "Lead departmental review and staff access.",
    functions: ["Review department uploads", "Approve staff requests", "Manage staff workspace"],
  },
  admin: {
    label: "Admin",
    summary: "Operate archive records, users, and review queues.",
    functions: ["Manage users and staff IDs", "Approve or reject uploads", "Monitor audit activity"],
  },
  "super-admin": {
    label: "Super Admin",
    summary: "Own system-wide controls and global operations.",
    functions: ["Control maintenance mode", "Send role notifications", "Configure root admin settings"],
  },
};

function currentRoleDefinition() {
  return roleDefinitions[roleSlug()] || roleDefinitions.student;
}

function roleFunctionPanel() {
  return "";
}

function shouldShowStudentOnboarding() {
  return Boolean(roleSlug() === "student" && !localStorage.getItem(userTourKey()));
}

function shouldShowRoleOnboarding() {
  return Boolean(state.user && state.user?.status !== "pending" && roleSlug() === "student" && loginCountForUser(state.user) <= 1 && !localStorage.getItem(userTourKey()));
}

function startRoleOnboarding({ delay = 5000 } = {}) {
  if (!shouldShowRoleOnboarding()) return;
  window.setTimeout(() => {
    if (!shouldShowRoleOnboarding()) return;
    state.tourActive = true;
    state.tourStep = 0;
    render();
    window.setTimeout(scrollTourFocusIntoView, 80);
  }, delay);
}

function notificationsForUser() {
  if (!state.user) return [];
  const name = currentName();
  const role = roleSlug();
  const adminNotes = (adminSettings.notifications || [])
    .filter((note) => note.targetRole === "all" || note.targetRole === role)
    .slice(0, 6)
    .map((note) => ({
      id: note.id,
      icon: icons.spark,
      title: note.title,
      body: note.body,
      at: note.at,
    }));
  const uploadNotes = appData.uploads
    .filter((item) => ["Approved", "Rejected"].includes(item.status) && (hasAdminAccess() || state.user?.hod || item.uploader === name || item.status === "Approved"))
    .slice(0, 8)
    .map((item) => ({
      id: `upload-${item.id}`,
      icon: item.status === "Rejected" ? icons.alert : item.status === "Approved" ? icons.check : icons.clock,
      title: uploadNotificationTitle(item),
      body: item.reviewComment || `${item.kind || "Resource"}: ${item.title}`,
      at: item.reviewedAt || item.at,
    }));
  if (role === "student") {
    return [
      ...adminNotes,
      ...uploadNotes.filter((item) => item.title.includes("Approved") || item.title.includes("live")),
    ].slice(0, 7);
  }
  return [...adminNotes, ...uploadNotes].slice(0, 9);
}

function uploadNotificationTitle(item) {
  if (item.status === "Approved") return "Upload approved";
  if (item.status === "Rejected") return "Upload rejected";
  return "Upload update";
}

function readSavedResources() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_RESOURCES_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeSavedResources(nextSaved) {
  localStorage.setItem(SAVED_RESOURCES_KEY, JSON.stringify(nextSaved));
}

function savedResourcesForUser() {
  if (state.liveArchive.loaded) return Array.isArray(state.liveArchive.savedIds) ? state.liveArchive.savedIds : [];
  const saved = readSavedResources();
  return Array.isArray(saved[userStorageId()]) ? saved[userStorageId()] : [];
}

function resourceKind(item) {
  return item.code || item.level ? "material" : "project";
}

function resourceId(item) {
  if (item?.source === "supabase" && item.id) return `${resourceKind(item)}:${item.id}`;
  return `${resourceKind(item)}:${String(item.title || item.code || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function isResourceSaved(item) {
  return savedResourcesForUser().includes(resourceId(item));
}

function savedResourceItems(kind = "") {
  const savedIds = new Set(savedResourcesForUser());
  return [...archiveProjects(), ...archiveMaterials()].filter((item) => savedIds.has(resourceId(item)) && (!kind || resourceKind(item) === kind));
}

function resourceById(id) {
  return [...archiveProjects(), ...archiveMaterials()].find((item) => resourceId(item) === id) || null;
}

async function toggleSavedResourceById(id) {
  if (!id) return null;
  const item = resourceById(id);
  if (state.liveArchive.loaded && state.session?.access_token && item?.source === "supabase" && item.id) {
    const saved = new Set(state.liveArchive.savedIds || []);
    const nextSaved = !saved.has(id);
    const kind = resourceKind(item);
    if (nextSaved) {
      await apiRequest("/api/student/saved", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ resourceType: kind, resourceId: item.id }),
      });
      saved.add(id);
    } else {
      await apiRequest(`/api/student/saved/${kind}/${item.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      saved.delete(id);
    }
    state.liveArchive.savedIds = [...saved];
    return { saved: nextSaved, kind, title: item?.title || "Resource" };
  }
  const saved = readSavedResources();
  const key = userStorageId();
  const current = new Set(Array.isArray(saved[key]) ? saved[key] : []);
  const nextSaved = !current.has(id);
  if (nextSaved) current.add(id);
  else current.delete(id);
  saved[key] = [...current];
  writeSavedResources(saved);
  return { saved: nextSaved, kind: item ? resourceKind(item) : "resource", title: item?.title || "Resource" };
}

function showBookmarkToast(result) {
  if (!result) return;
  const id = Date.now();
  const label = result.kind === "material" ? "material" : result.kind === "project" ? "project" : "resource";
  state.bookmarkToast = {
    id,
    saved: result.saved,
    title: result.title,
    message: result.message || (result.saved ? `${label === "project" ? "Bookmarked" : "Saved"} to library` : `Removed from saved ${label}s`),
  };
  if (bookmarkToastTimer) window.clearTimeout(bookmarkToastTimer);
  bookmarkToastTimer = window.setTimeout(() => {
    if (state.bookmarkToast?.id === id) {
      state.bookmarkToast = null;
      render();
    }
  }, 2400);
}

function showStatusToast(message, title = "Nexaa", saved = true) {
  showBookmarkToast({
    saved,
    title,
    message,
    kind: "status",
  });
}

function setAuthError(message, title = "Authentication") {
  state.authError = message || "";
  if (message) showStatusToast(message, title, false);
}

function loadingIcon() {
  return `<span class="button-loader" aria-hidden="true"></span>`;
}

function submitButton(id, icon, label) {
  const loading = state.authSubmitting === id;
  return `<button class="auth-submit ${loading ? "is-loading" : ""}" type="submit" ${loading ? "disabled" : ""}>${loading ? loadingIcon() : icon}<span>${escapeHtml(loading ? "Please wait..." : label)}</span></button>`;
}

function roleInlineIcon(icon) {
  return `<span class="role-inline-icon" aria-hidden="true">${icon}</span>`;
}

function generateStaffIdCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = new Uint32Array(8);
  crypto.getRandomValues(values);
  return `ARE${Array.from(values, (value) => chars[value % chars.length]).join("")}`;
}

function errorMessage(section, key) {
  return errorMessages[section]?.[key] || errorMessages.general.unexpected;
}

function setAuthErrorKey(section, key, title = "Authentication") {
  setAuthError(errorMessage(section, key), title);
}

function showErrorToast(section, key, title = "Nexaa") {
  showStatusToast(errorMessage(section, key), title, false);
}

function fieldErrorMarkup(message) {
  if (!message) return "";
  return `<span class="field-error locked">${icons.lock || ""}<b>${escapeHtml(message)}</b></span>`;
}

async function loadStudentArchive({ force = false } = {}) {
  if (!state.user || !state.session?.access_token) return;
  if (!force && studentArchiveRetryAt && Date.now() < studentArchiveRetryAt) return;
  if (state.liveArchive.loading || (state.liveArchive.loaded && !force)) return;
  const previousSnapshot = stableJson({ archive: state.liveArchive, user: state.user });
  state.liveArchive.loading = true;
  state.liveArchive.error = "";
  try {
    const data = await apiRequest("/api/student/archive", {
      headers: authHeaders(),
    });
    state.liveArchive = {
      loaded: true,
      loading: false,
      error: "",
      projects: Array.isArray(data.projects) ? data.projects : [],
      materials: Array.isArray(data.materials) ? data.materials : [],
      savedIds: Array.isArray(data.savedIds) ? data.savedIds : [],
      notifications: Array.isArray(data.notifications) ? data.notifications : [],
    };
    if (data.profile) {
      state.user = frontendUserFromAuth({ profile: data.profile }, state.user);
      localStorage.setItem("nexaa-user", JSON.stringify(state.user));
    }
    mergeRemoteNotifications(state.liveArchive.notifications);
    studentArchiveRetryAt = 0;
  } catch (error) {
    state.liveArchive.loading = false;
    state.liveArchive.loaded = true;
    state.liveArchive.error = errorMessage("archive", "unavailable");
    studentArchiveRetryAt = Date.now() + 30000;
    console.warn("Archive load failed:", error?.message || error);
  }
  const changed = previousSnapshot !== stableJson({ archive: state.liveArchive, user: state.user });
  if (changed && ["dashboard", "projects", "materials", "search", "saved"].includes(state.route) && !state.appBooting) render();
}

function scheduleStudentArchiveLoad(force = false) {
  if (!state.user || !state.session?.access_token) return;
  if (!force && studentArchiveRetryAt && Date.now() < studentArchiveRetryAt) return;
  if (!force && (state.liveArchive.loading || state.liveArchive.loaded)) return;
  if (studentArchiveTimer) window.clearTimeout(studentArchiveTimer);
  studentArchiveTimer = window.setTimeout(() => {
    studentArchiveTimer = null;
    loadStudentArchive({ force });
  }, 120);
}

async function loadStaffWorkspace({ force = false } = {}) {
  if (!state.user || !state.session?.access_token || !hasStaffAccess()) return;
  if (state.liveStaff.loading || (state.liveStaff.loaded && !force)) return;
  const previousSnapshot = stableJson({ staff: state.liveStaff, user: state.user });
  state.liveStaff.loading = true;
  state.liveStaff.error = "";
  try {
    const data = await apiRequest("/api/staff/dashboard", {
      headers: authHeaders(),
    });
    state.liveStaff = {
      loaded: true,
      loading: false,
      error: "",
      uploads: Array.isArray(data.uploads) ? data.uploads : [],
      staff: Array.isArray(data.staff) ? data.staff : [],
    };
    if (data.profile) {
      state.user = frontendUserFromAuth({ profile: data.profile }, state.user);
      localStorage.setItem("nexaa-user", JSON.stringify(state.user));
    }
  } catch (error) {
    state.liveStaff.loading = false;
    state.liveStaff.error = errorMessage("general", "backendOffline");
  }
  const changed = previousSnapshot !== stableJson({ staff: state.liveStaff, user: state.user });
  if (changed && ["dashboard", "lecturer", "upload"].includes(state.route) && !state.appBooting) render();
}

function scheduleStaffWorkspaceLoad(force = false) {
  if (!state.user || !state.session?.access_token || !hasStaffAccess()) return;
  if (!force && (state.liveStaff.loading || state.liveStaff.loaded)) return;
  window.setTimeout(() => loadStaffWorkspace({ force }), 0);
}

function applyLiveAdminPayload(data = {}) {
  const previousSnapshot = stableJson({ liveAdmin: state.liveAdmin, settings: adminSettings });
  if (data.rootSettings) {
    adminSettings = { ...adminSettings, ...data.rootSettings };
    localStorage.setItem(ADMIN_SETTINGS_KEY, JSON.stringify(adminSettings));
  }
  state.liveAdmin = {
    loaded: true,
    loading: false,
    error: "",
    stats: data.stats || null,
    users: Array.isArray(data.users) ? data.users.map((user) => ({
      id: user.id,
      name: user.name || user.email || "Nexaa User",
      email: user.email || "",
      role: displayRole(user),
      status: titleText(user.status || "active"),
      staffEmail: user.staffEmail || "",
      matricNumber: user.matricNumber || "",
      staffId: user.staffId || "",
      level: user.level || "",
      department: user.department || DEPARTMENT_NAME,
      title: user.title || "",
      lastSeen: user.updatedAt || user.createdAt || new Date().toISOString(),
    })) : [],
    staffIds: Array.isArray(data.staffIds) ? data.staffIds : [],
    uploads: Array.isArray(data.uploads) ? data.uploads : [],
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    rootSettings: data.rootSettings || null,
  };
  if (state.liveAdmin.users.length) {
    appData = readData();
    appData.users = state.liveAdmin.users;
    appData.staffIds = state.liveAdmin.staffIds;
    appData.uploads = state.liveAdmin.uploads;
    writeData(appData);
  }
  return previousSnapshot !== stableJson({ liveAdmin: state.liveAdmin, settings: adminSettings });
}

async function loadAdminOverview({ force = false } = {}) {
  if (!state.user || !state.session?.access_token || !hasAdminAccess()) return;
  if (state.liveAdmin.loading || (state.liveAdmin.loaded && !force)) return;
  let changed = false;
  state.liveAdmin.loading = true;
  state.liveAdmin.error = "";
  try {
    const data = await apiRequest("/api/admin/overview", {
      headers: authHeaders(),
    });
    changed = applyLiveAdminPayload(data);
  } catch (error) {
    const previousSnapshot = stableJson(state.liveAdmin);
    const hadUsableData = state.liveAdmin.users.length || state.liveAdmin.uploads.length || state.liveAdmin.staffIds.length;
    state.liveAdmin.loading = false;
    state.liveAdmin.loaded = hadUsableData || [401, 403].includes(Number(error?.status));
    state.liveAdmin.error = error?.message || errorMessage("general", "backendOffline");
    if ([401, 403].includes(Number(error?.status))) {
      state.session = null;
      state.liveAdmin.error = "Invalid session";
      sessionStorage.removeItem("nexaa-session");
      localStorage.removeItem("nexaa-session");
      if (state.route === "admin" || state.route === "sentinel") {
        state.route = "login";
        state.authMode = "login";
        updateMeta("login");
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#login`);
        render();
        return;
      }
    }
    changed = previousSnapshot !== stableJson(state.liveAdmin);
  }
  if (changed && state.route === "admin") render();
}

function scheduleAdminOverviewLoad(force = false) {
  if (!state.user || !state.session?.access_token || !hasAdminAccess()) return;
  if (!force && (state.liveAdmin.loading || state.liveAdmin.loaded)) return;
  if (adminOverviewTimer) window.clearTimeout(adminOverviewTimer);
  adminOverviewTimer = window.setTimeout(() => {
    adminOverviewTimer = null;
    loadAdminOverview({ force });
  }, 120);
}

function frontendSupportRequest(row = {}) {
  return {
    id: row.id || crypto.randomUUID(),
    email: row.email || "",
    subject: row.subject || "Support message",
    message: row.message || "",
    status: row.status || "open",
    reply: row.admin_reply || "",
    repliedAt: row.replied_at || "",
    at: row.created_at || row.at || new Date().toISOString(),
    updatedAt: row.updated_at || row.replied_at || row.created_at || row.at || new Date().toISOString(),
  };
}

async function loadSupportInbox({ force = false } = {}) {
  if (!state.user || !state.session?.access_token || !hasAdminAccess()) return;
  if (state.liveSupport.loading || (state.liveSupport.loaded && !force)) return;
  const previousSnapshot = stableJson(state.liveSupport);
  state.liveSupport.loading = true;
  state.liveSupport.error = "";
  try {
    const data = await apiRequest("/api/support/requests", {
      headers: authHeaders(),
    });
    state.liveSupport = {
      loaded: true,
      loading: false,
      error: "",
      requests: Array.isArray(data.requests) ? data.requests.map(frontendSupportRequest) : [],
      replying: state.liveSupport.replying,
    };
  } catch (error) {
    state.liveSupport.loading = false;
    state.liveSupport.loaded = true;
    state.liveSupport.error = error?.message || errorMessage("general", "backendOffline");
  }
  const changed = previousSnapshot !== stableJson(state.liveSupport);
  if (changed && state.route === "admin" && state.adminView === "messages") render();
}

function scheduleSupportInboxLoad(force = false) {
  if (!state.user || !state.session?.access_token || !hasAdminAccess()) return;
  if (!force && (state.liveSupport.loading || state.liveSupport.loaded)) return;
  if (supportInboxTimer) window.clearTimeout(supportInboxTimer);
  supportInboxTimer = window.setTimeout(() => {
    supportInboxTimer = null;
    loadSupportInbox({ force });
  }, 120);
}

async function loadSecurityCenter({ force = false } = {}) {
  if (!state.user || !state.session?.access_token || !isSuperAdmin()) return;
  if (state.liveSecurity.loading || (state.liveSecurity.loaded && !force)) return;
  const previousSnapshot = stableJson({ security: state.liveSecurity, sentinelMode: state.sentinelMode });
  state.liveSecurity.loading = true;
  state.liveSecurity.error = "";
  try {
    const data = await apiRequest("/api/security/overview", {
      headers: authHeaders(),
    });
    state.liveSecurity = {
      loaded: true,
      loading: false,
      error: "",
      status: data.status || null,
      metrics: data.metrics || null,
      logs: Array.isArray(data.logs) ? data.logs : [],
      alerts: Array.isArray(data.alerts) ? data.alerts : [],
      threats: Array.isArray(data.threats) ? data.threats : [],
      monitoring: data.monitoring || null,
      backups: Array.isArray(data.backups) ? data.backups : [],
      settings: data.settings || null,
    };
    state.sentinelMode = data.status?.modeSlug || String(data.status?.mode || state.sentinelMode || "normal").toLowerCase();
  } catch (error) {
    state.liveSecurity.loading = false;
    state.liveSecurity.loaded = true;
    state.liveSecurity.error = error?.message || errorMessage("general", "backendOffline");
  }
  const changed = previousSnapshot !== stableJson({ security: state.liveSecurity, sentinelMode: state.sentinelMode });
  if (changed && (state.route === "sentinel" || (state.route === "admin" && state.adminView === "security-center"))) render();
}

function scheduleSecurityCenterLoad(force = false) {
  if (!state.user || !state.session?.access_token || !isSuperAdmin()) return;
  if (!force && (state.liveSecurity.loading || state.liveSecurity.loaded)) return;
  if (securityCenterTimer) window.clearTimeout(securityCenterTimer);
  securityCenterTimer = window.setTimeout(() => {
    securityCenterTimer = null;
    loadSecurityCenter({ force });
  }, 120);
}

function initials(name = currentName()) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function readProfileBucket() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_BUCKET_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeProfileBucket(nextBucket) {
  localStorage.setItem(PROFILE_BUCKET_KEY, JSON.stringify(nextBucket));
}

function profileRecord(email = state.user?.email) {
  if (!email) return null;
  const bucket = readProfileBucket();
  return bucket[String(email).toLowerCase()] || null;
}

function profileAvatar(name = currentName(), className = "dash-avatar") {
  const record = profileRecord();
  const content = record?.dataUrl
    ? `<img src="${record.dataUrl}" alt="${escapeHtml(name)} profile picture" />`
    : escapeHtml(initials(name));
  return `<button class="${className} profile-avatar-button" data-action="changeProfile" type="button" aria-label="Change profile picture">${content}</button>`;
}

function adminProfileAvatar(name = currentName()) {
  const record = profileRecord();
  const content = record?.dataUrl
    ? `<img src="${record.dataUrl}" alt="${escapeHtml(name)} profile picture" />`
    : `<span>${escapeHtml(initials(name))}</span>`;
  return `<button class="admin-avatar profile-avatar-button" data-action="changeProfile" type="button" aria-label="Change profile picture">${content}<i></i></button>`;
}

function navAvatar(name = currentName()) {
  const record = profileRecord();
  return record?.dataUrl
    ? `<span class="nav-avatar"><img src="${record.dataUrl}" alt="${escapeHtml(name)} profile picture" /></span>`
    : `<span class="nav-avatar">${escapeHtml(initials(name))}</span>`;
}

function saveProfilePicture(file) {
  if (!file || !state.user?.email) return;
  const reader = new FileReader();
  reader.onload = () => {
    const bucket = readProfileBucket();
    const email = String(state.user.email).toLowerCase();
    bucket[email] = {
      id: crypto.randomUUID(),
      email,
      dataUrl: String(reader.result),
      fileName: file.name,
      updatedAt: new Date().toISOString(),
    };
    writeProfileBucket(bucket);
    state.user.profilePictureId = bucket[email].id;
    localStorage.setItem("nexaa-user", JSON.stringify(state.user));
    upsertUser(state.user);
    addActivity("PROFILE", "Profile picture updated and previous image replaced", currentName());
    render();
  };
  reader.readAsDataURL(file);
}

function apiBaseUrl() {
  const configured = window.NEXA_API_BASE_URL || localStorage.getItem("nexa-api-base-url") || DEFAULT_API_BASE_URL;
  return configured ? configured.replace(/\/$/, "") : "";
}

async function apiRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers["content-type"] = "application/json";
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Backend request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function apiBlobRequest(path, options = {}) {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...options,
    headers: { ...(options.headers || {}) },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || "Backend request failed");
    error.status = response.status;
    throw error;
  }
  return response.blob();
}

function authHeaders() {
  const token = state.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function frontendUserFromAuth(data, fallback = {}) {
  const profile = data?.profile || {};
  const authUser = data?.user || {};
  const role = displayRole({ role: profile.role || fallback.role || "Student", superAdmin: fallback.superAdmin });
  return {
    id: profile.id || authUser.id || fallback.id,
    name: profile.name || fallback.name || authUser.user_metadata?.name || authUser.email || "Nexaa User",
    email: profile.email || authUser.email || fallback.email || "",
    role,
    department: profile.department || fallback.department || DEPARTMENT_NAME,
    matricNumber: profile.matricNumber || fallback.matricNumber || "",
    level: profile.level || fallback.level || "",
    staffId: profile.staffId || fallback.staffId || "",
    staffEmail: profile.staffEmail || fallback.staffEmail || "",
    title: profile.title || fallback.title || "",
    status: profile.status || fallback.status || "active",
    supabase: Boolean(data?.session || authUser.id),
  };
}

function persistAuthSession(data, fallback = {}) {
  state.session = data?.session || null;
  state.user = frontendUserFromAuth(data, fallback);
  state.user.role = displayRole(state.user);
  state.liveArchive = { loaded: false, loading: false, error: "", projects: [], materials: [], savedIds: [], notifications: [] };
  state.isStaff = hasStaffWorkspaceAccess();
  state.authError = "";
  localStorage.setItem("nexaa-user", JSON.stringify(state.user));
  if (state.session) sessionStorage.setItem("nexaa-session", JSON.stringify(state.session));
  else sessionStorage.removeItem("nexaa-session");
  localStorage.removeItem("nexaa-session");
  localStorage.setItem("nexaa-email", state.user.email);
  upsertUser(state.user);
  recordLogin(state.user);
  startRoleOnboarding();
  scheduleSupabaseRealtimeSetup();
  scheduleStudentArchiveLoad(true);
  scheduleAdminOverviewLoad(true);
}

async function refreshBackendProfile() {
  if (!state.session?.access_token) return false;
  try {
    const data = await apiRequest("/api/auth/me", {
      headers: authHeaders(),
    });
    const refreshedUser = frontendUserFromAuth({ ...data, session: state.session }, state.user || {});
    refreshedUser.role = displayRole(refreshedUser);
    const previous = JSON.stringify(state.user || {});
    const next = JSON.stringify(refreshedUser || {});
    state.user = refreshedUser;
    state.isStaff = hasStaffWorkspaceAccess();
    localStorage.setItem("nexaa-user", JSON.stringify(state.user));
    localStorage.setItem("nexaa-email", state.user.email);
    upsertUser(state.user);
    return previous !== next;
  } catch {
    return false;
  }
}

function buildResetLink(token) {
  const url = new URL(window.location.href);
  if (token) url.searchParams.set("reset_token", token);
  url.hash = "login";
  return url.toString();
}

function resetModalState(method = "otp") {
  state.resetMethod = method;
  state.resetStep = "request";
  state.resetSent = false;
  state.resetOtp = "";
  state.resetOtpInput = "";
  state.resetToken = "";
  state.resetAccessToken = "";
  state.resetRefreshToken = "";
  state.resetLink = "";
  state.resetDelivery = "";
  state.resetError = "";
  state.resetPassword = "";
  state.resetConfirm = "";
}

async function requestSignupOtp() {
  try {
    const data = await apiRequest("/api/auth/request-otp", {
      method: "POST",
      body: JSON.stringify({ email: state.email, recaptchaToken: state.recaptchaToken }),
    });
    state.signupOtpDelivery = data.delivery || "email";
    state.signupOtp = "";
    addActivity("AUTH", `Signup OTP requested for ${state.email}`, "System");
  } catch (error) {
    if (error.status && error.status !== 502 && error.status !== 503) {
      setAuthErrorKey("signup", /recaptcha|security/i.test(error.message || "") ? "recaptchaFailed" : "otpSendFailed");
      if (window.grecaptcha?.reset) window.grecaptcha.reset();
      state.recaptchaToken = "";
      throw error;
    }
    setAuthErrorKey("signup", "otpSendFailed");
    throw error;
  }
  state.signupOtpInput = "";
  state.authStep = "verify-signup";
}

function signupOtpCooldownSeconds() {
  return Math.max(0, Math.ceil((Number(state.signupOtpCooldownUntil || 0) - Date.now()) / 1000));
}

async function resendSignupOtp() {
  const cooldown = signupOtpCooldownSeconds();
  if (cooldown > 0) {
    setAuthError(`Please wait ${cooldown}s before requesting another code.`, "Verification");
    render();
    return;
  }
  if (state.signupOtpResends >= 3) {
    setAuthError("You have reached the resend limit. Try again later.", "Verification");
    render();
    return;
  }
  state.signupOtpResending = true;
  state.authError = "";
  render();
  try {
    await requestSignupOtp();
    state.signupOtpResends += 1;
    state.signupOtpCooldownUntil = Date.now() + 60000;
    state.authStep = "verify-signup";
    showStatusToast("A new verification code has been sent.", state.email, true);
  } catch {
    setAuthErrorKey("signup", "otpSendFailed");
  }
  state.signupOtpResending = false;
  render();
}

async function verifySignupOtp(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const otp = String(form.get("signupOtp") || "").trim();
  state.signupOtpInput = otp;
  state.authError = "";
  state.authSubmitting = "verify-otp";
  render();

  try {
    const data = await apiRequest("/api/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ email: state.email, token: otp }),
    });
    state.signupAccessToken = data.session?.access_token || "";
    state.signupRefreshToken = data.session?.refresh_token || "";
    state.authStep = "setup-loading";
    showStatusToast("Email verified. Choose your role.", state.email, true);
    window.setTimeout(() => {
      if (state.authMode === "signup" && state.authStep === "setup-loading") {
        state.authStep = "role";
        render();
      }
    }, 650);
  } catch {
    setAuthErrorKey("signup", "otpIncorrect");
  }
  state.authSubmitting = "";
  render();
}

async function requestPasswordReset(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const email = String(form.get("resetEmail") || state.email || "").trim().toLowerCase();
  const method = "link";
  state.resetEmail = email;
  state.resetMethod = method;
  setResetError("");

  if (!email) {
    setResetError(errorMessage("reset", "missingEmail"));
    render();
    return;
  }

  state.authSubmitting = "reset-link";
  render();
  try {
    const redirectTo = buildResetLink();
    await apiRequest("/api/auth/password-reset-link", {
      method: "POST",
      body: JSON.stringify({ email, redirectTo }),
    });
    state.resetDelivery = "email";
    state.resetLink = "";
    state.resetStep = "link-sent";
    addActivity("AUTH", `Password reset link requested for ${email}`, "System");
  } catch (error) {
    state.authSubmitting = "";
    setResetError(errorMessage("reset", "linkSendFailed"));
    render();
    return;
  }
  state.resetSent = true;
  state.authSubmitting = "";
  render();
}

async function requestRootPasswordReset(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  state.rootEmail = normalizedEmail;
  state.rootRecoverEmail = normalizedEmail;
  state.authError = "";
  state.resetOpen = false;

  if (!normalizedEmail) {
    setAuthError("Enter the Super Admin email first.", "Root");
    render();
    return;
  }

  state.authSubmitting = "root-reset-link";
  render();
  try {
    await apiRequest("/api/auth/root-password-reset-link", {
      method: "POST",
      body: JSON.stringify({
        email: normalizedEmail,
        redirectTo: buildResetLink(),
      }),
    });
    state.resetEmail = normalizedEmail;
    state.resetDelivery = "email";
    state.resetLink = "";
    state.resetStep = "link-sent";
    state.resetSent = true;
    state.resetOpen = false;
    state.rootRecoverOpen = false;
    addActivity("AUTH", "Root recovery link requested", "System");
    showStatusToast("Root recovery link sent.", normalizedEmail, true);
  } catch (error) {
    setAuthError(error.message || "Root recovery failed.", "Root");
  }
  state.authSubmitting = "";
  render();
}

async function completePasswordReset(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const password = String(form.get("newPassword") || "");
  const confirm = String(form.get("confirmPassword") || "");
  const email = String(state.resetEmail || state.email || "").trim().toLowerCase();

  setResetError("");
  if (!state.resetError && password.length < 8) {
    setResetError(errorMessage("reset", "passwordTooShort"));
  }
  if (!state.resetError && password !== confirm) {
    setResetError(errorMessage("reset", "passwordMismatch"));
  }

  if (state.resetError) {
    render();
    return;
  }
  if (!state.resetAccessToken) {
    setResetError(errorMessage("reset", "linkExpired"));
    render();
    return;
  }

  state.authSubmitting = "reset-password";
  render();
  try {
    await apiRequest("/api/auth/update-password", {
      method: "POST",
      body: JSON.stringify({
        accessToken: state.resetAccessToken,
        refreshToken: state.resetRefreshToken,
        password,
      }),
    });
  } catch (error) {
    state.authSubmitting = "";
    setResetError(errorMessage("reset", "updateFailed"));
    render();
    return;
  }

  state.email = email;
  state.password = "";
  state.resetEmail = email;
  state.resetStep = "done";
  state.resetToken = "";
  state.resetLink = "";
  state.authSubmitting = "";
  addActivity("AUTH", `Password reset completed for ${email}`, "System");
  render();
}

function fileExtension(fileName = "") {
  return String(fileName).split(".").pop()?.toLowerCase() || "";
}

function formatFileSize(bytes = 0) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function validateUploadFile(file) {
  if (!file) return errorMessage("uploads", "missingMetadata");
  const extension = fileExtension(file.name);
  if (!allowedUploadExtensions.includes(extension)) {
    return errorMessage("uploads", "invalidType");
  }
  if (file.size > maxUploadBytes) {
    return `${errorMessage("uploads", "tooLarge")} Maximum upload size is ${formatFileSize(maxUploadBytes)}.`;
  }
  return "";
}

async function uploadProtectedFile({ file, title, kind, metadata = {} }) {
  if (!state.session?.access_token) {
    throw new Error(errorMessage("uploads", "notStaff"));
  }
  const body = new FormData();
  body.append("file", file);
  body.append("title", title);
  body.append("kind", kind);
  Object.entries(metadata).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") body.append(key, value);
  });
  return apiRequest("/api/files", {
    method: "POST",
    headers: authHeaders(),
    body,
  });
}

function setUploadFile(file) {
  const error = validateUploadFile(file);
  state.uploadFile = error ? null : file;
  state.uploadError = error;
  render();
}

function hasGoogleClientId() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== GOOGLE_CLIENT_ID_PLACEHOLDER && !GOOGLE_CLIENT_ID.includes("YOUR_GOOGLE_CLIENT_ID"));
}

function googleSignInError(type = "generic") {
  return errorMessages.google[type] || errorMessages.google.generic;
}

function setGoogleSignInError(type = "generic") {
  setAuthError(googleSignInError(type), "Google sign in");
}

function isGoogleOnlyLoginError(error) {
  return Boolean(error?.status === 401 && state.email && !state.password);
}

function classifyGoogleFailure(error) {
  const raw = String(error?.error || error?.type || error?.message || error || "").toLowerCase();
  if (!navigator.onLine || /network|fetch|internet|offline|failed to fetch|load failed|err_network/i.test(raw)) return "network";
  if (/popup|closed|cancel|dismiss|skip/i.test(raw)) return "cancelled";
  if (/access_denied|permission|consent|denied/i.test(raw)) return "permission";
  if (/already|exists|registered/i.test(raw)) return "accountExists";
  if (/redirect|origin|client|oauth|unauthorized|invalid_request|invalid_client|configuration|config/i.test(raw)) return "oauthConfig";
  if (/expired|session|token/i.test(raw)) return "generic";
  return "generic";
}

function googleAccountAlreadyExists(email = "") {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return false;
  const localUserExists = appData.users.some((user) => String(user.email || "").trim().toLowerCase() === key);
  return Boolean(localUserExists);
}

function loadExternalScriptOnce(src, id) {
  if (document.getElementById(id)) return;
  const script = document.createElement("script");
  script.id = id;
  script.src = src;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

function loadGoogleAuthScript() {
  if (window.google?.accounts) return;
  loadExternalScriptOnce("https://accounts.google.com/gsi/client", "nexaa-google-gsi");
}

function loadRecaptchaScript() {
  if (!RECAPTCHA_SITE_KEY || window.grecaptcha?.render) return;
  loadExternalScriptOnce("https://www.google.com/recaptcha/api.js", "nexaa-recaptcha-api");
}

function recaptchaMarkup() {
  if (!RECAPTCHA_SITE_KEY) {
    return `<div class="recaptcha-note">${icons.shield}<span>Google reCAPTCHA will run when a site key is configured.</span></div>`;
  }
  if (state.recaptchaToken) {
    return `<div class="recaptcha-note recaptcha-verified">${icons.check}<span>Security check passed.</span></div>`;
  }
  return `<div class="recaptcha-wrap"><span class="recaptcha-loading">Loading security check...</span><div class="g-recaptcha" data-sitekey="${escapeHtml(RECAPTCHA_SITE_KEY)}"></div></div>`;
}

function readRecaptchaToken(form) {
  const formToken = String(new FormData(form).get("g-recaptcha-response") || "").trim();
  if (formToken) return formToken;
  if (state.recaptchaToken) return state.recaptchaToken;
  if (window.grecaptcha?.getResponse) {
    try {
      return String(window.grecaptcha.getResponse() || "").trim();
    } catch {
      return "";
    }
  }
  return "";
}

function mountRecaptcha() {
  if (!RECAPTCHA_SITE_KEY) return;
  const boxes = [...document.querySelectorAll(".g-recaptcha")].filter((box) => !box.dataset.widgetId);
  if (!boxes.length) return;
  loadRecaptchaScript();
  if (!window.grecaptcha?.render) {
    window.setTimeout(mountRecaptcha, 350);
    return;
  }
  boxes.forEach((box) => {
    try {
      const widgetId = window.grecaptcha.render(box, {
        sitekey: RECAPTCHA_SITE_KEY,
        callback(token) {
          state.recaptchaToken = String(token || "");
          state.authError = "";
        },
        "expired-callback"() {
          state.recaptchaToken = "";
        },
        "error-callback"() {
          state.recaptchaToken = "";
          setAuthErrorKey("signup", "recaptchaFailed", "Security check");
        },
      });
      box.dataset.widgetId = String(widgetId);
    } catch (error) {
      if (!/already rendered/i.test(String(error?.message || error))) {
        setAuthErrorKey("google", "scriptMissing", "Security check");
      }
    }
  });
}

function decodeGoogleCredential(credential) {
  const payload = String(credential || "").split(".")[1];
  if (!payload) throw new Error("Missing Google credential payload");
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return JSON.parse(decodeURIComponent(escape(atob(padded))));
}

function continueGoogleProfileSetup(profile, { accessToken = "", credential = "" } = {}) {
  const name = profile.name || `${profile.given_name || "Google"} ${profile.family_name || "User"}`.trim();
  const email = profile.email || state.email || "google.user@nexa.local";
  state.googleProfile = {
    ...profile,
    name,
    email,
  };
  state.googleAccessToken = accessToken;
  state.googleCredential = credential;
  state.email = email;
  const parts = name.split(/\s+/).filter(Boolean);
  state.firstName = profile.given_name || parts[0] || "";
  state.lastName = profile.family_name || parts.slice(1).join(" ") || "";
  state.password = "";
  state.profileRole = "student";
  state.isStaff = false;
  state.authMode = "signup";
  state.authStep = "setup-loading";
  state.googleAuthInProgress = false;
  state.authError = "";
  render();
  window.setTimeout(() => {
    if (state.authMode === "signup" && state.authStep === "setup-loading") {
      state.authStep = "role";
      render();
    }
  }, 650);
}

function completeGoogleSignIn(profile) {
  continueGoogleProfileSetup(profile);
}

function handleGoogleCredential(response) {
  try {
    continueGoogleProfileSetup(decodeGoogleCredential(response?.credential), { credential: response?.credential || "" });
  } catch {
    setGoogleSignInError("generic");
    render();
  }
}

async function completeGoogleOAuth(response) {
  if (!response?.access_token) {
    state.googleAuthInProgress = false;
    setGoogleSignInError(classifyGoogleFailure(response));
    render();
    return;
  }
  try {
    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${response.access_token}` },
    });
    if (!profileResponse.ok) throw new Error(profileResponse.status === 401 ? "session expired" : "permission denied");
    continueGoogleProfileSetup(await profileResponse.json(), { accessToken: response.access_token });
  } catch (error) {
    state.googleAuthInProgress = false;
    setGoogleSignInError(classifyGoogleFailure(error));
    render();
  }
}

function initializeGoogleAuth() {
  if (state.googleAuthReady) return true;
  if (!hasGoogleClientId()) {
    setGoogleSignInError("oauthConfig");
    return false;
  }
  if (!window.google?.accounts?.id) {
    setGoogleSignInError(navigator.onLine ? "scriptMissing" : "network");
    return false;
  }
  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  state.googleAuthReady = true;
  return true;
}

function mountGoogleButton() {
  const host = document.querySelector("[data-google-button]");
  if (!host || state.user) return;
  if (!hasGoogleClientId()) return;
  loadGoogleAuthScript();
  if (!window.google?.accounts?.id) {
    window.setTimeout(mountGoogleButton, 400);
    return;
  }
  if (!initializeGoogleAuth()) return;
  host.classList.remove("google-rendered");
}

function continueWithGmail() {
  if (state.googleAuthInProgress || Date.now() < Number(state.googleAuthCooldownUntil || 0)) return;
  state.authError = "";
  if (!hasGoogleClientId()) {
    setGoogleSignInError("oauthConfig");
    render();
    return;
  }
  loadGoogleAuthScript();
  if (!window.google?.accounts) {
    state.googleAuthInProgress = true;
    window.setTimeout(() => {
      state.googleAuthInProgress = false;
      if (window.google?.accounts) continueWithGmail();
      else {
        setGoogleSignInError(navigator.onLine ? "scriptMissing" : "network");
        render();
      }
    }, 650);
    return;
  }

  state.googleAuthInProgress = true;
  state.googleAuthCooldownUntil = Date.now() + 5000;
  if (window.google.accounts.oauth2?.initTokenClient) {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: "openid email profile",
      prompt: "select_account",
      callback: completeGoogleOAuth,
      error_callback: (error) => {
        state.googleAuthInProgress = false;
        setGoogleSignInError(classifyGoogleFailure(error));
        render();
      },
    });
    tokenClient.requestAccessToken();
    return;
  }

  if (!initializeGoogleAuth()) {
    state.googleAuthInProgress = false;
    render();
    return;
  }

  window.google.accounts.id.cancel();
  window.google.accounts.id.prompt((notification) => {
    if (notification.isDismissedMoment?.() && notification.getDismissedReason?.() === "credential_returned") return;
    if (notification.isNotDisplayed?.()) {
      state.googleAuthInProgress = false;
      const reason = notification.getNotDisplayedReason?.() || "";
      setGoogleSignInError(classifyGoogleFailure(reason || "oauth config"));
      render();
      return;
    }
    if (notification.isSkippedMoment?.()) {
      state.googleAuthInProgress = false;
      setGoogleSignInError(classifyGoogleFailure(notification.getSkippedReason?.() || "cancelled"));
      render();
      return;
    }
    if (notification.isDismissedMoment?.()) {
      state.googleAuthInProgress = false;
      setGoogleSignInError(classifyGoogleFailure(notification.getDismissedReason?.() || "cancelled"));
      render();
    }
  });
}

window.handleGoogleCredential = handleGoogleCredential;

const routeMeta = {
  home: {
    title: "Nexaa | ARE Academic Archive",
    description: "Explore the Agricultural and Resource Economics academic archive, built by ARE Class '25 - The Agro Nexas for projects, materials, staff uploads, and searchable departmental knowledge.",
  },
  login: {
    title: "Login or Sign Up | Nexaa Academic Archive",
    description: "Access Nexaa with email, Gmail, or staff credentials to browse projects, materials, and university resources.",
  },
  dashboard: {
    title: "Student Dashboard | Nexaa",
    description: "Browse projects, materials, and quick archive tools from the Nexaa student dashboard.",
  },
  projects: {
    title: "Academic Works Archive | Nexaa",
    description: "Search final year projects, research, proposals, IT reports, and seminar works in Nexaa.",
  },
  materials: {
    title: "Academic Materials | Nexaa",
    description: "Find course materials, past questions, lecture notes, and slides by level and course code.",
  },
  search: {
    title: "Search Archive | Nexaa",
    description: "Search projects, materials, authors, course codes, and academic resources across Nexaa.",
  },
  upload: {
    title: "Upload Resource | Nexaa",
    description: "Staff can upload projects and academic materials into the Nexaa review workflow.",
  },
  lecturer: {
    title: "Staff and HOD Panel | Nexaa",
    description: "Manage uploads, review queues, and staff privileges from the Nexaa staff and HOD panel.",
  },
  admin: {
    title: "Admin Control Center | Nexaa",
    description: "Monitor users, staff, materials, uploads, reviews, and live archive activity from the Nexaa admin panel.",
  },
};

function updateMeta(route) {
  const baseMeta = routeMeta[route] || routeMeta.home;
  const meta = route === "admin" && isSuperAdmin()
    ? {
      title: "Super Admin Control Center | Nexaa",
      description: "Monitor role governance, Sentinel, root settings, staff promotion, reviews, and live activity from the Nexaa super admin panel.",
    }
    : baseMeta;
  document.title = meta.title;
  const description = document.querySelector("meta[name='description']");
  if (description) description.setAttribute("content", meta.description);
  const ogTitle = document.querySelector("meta[property='og:title']");
  if (ogTitle) ogTitle.setAttribute("content", meta.title);
  const ogDescription = document.querySelector("meta[property='og:description']");
  if (ogDescription) ogDescription.setAttribute("content", meta.description);
  const twitterTitle = document.querySelector("meta[name='twitter:title']");
  if (twitterTitle) twitterTitle.setAttribute("content", meta.title);
  const twitterDescription = document.querySelector("meta[name='twitter:description']");
  if (twitterDescription) twitterDescription.setAttribute("content", meta.description);
}

async function signInFromForm(event) {
  // Signup starts with an email availability check, then profile setup creates the account.
  event.preventDefault();
  const form = new FormData(event.target);
  if (state.authMode === "signup") {
    state.email = String(form.get("username") || state.email || "").trim().toLowerCase();
    state.password = String(form.get("current-password") || state.password || "");
    state.recaptchaToken = readRecaptchaToken(event.target);
    state.authError = "";
    if (!state.email || !state.password) {
      setAuthErrorKey("signup", "missingCredentials");
      render();
      return;
    }
    if (state.password.length < 8) {
      setAuthErrorKey("signup", "passwordTooShort");
      render();
      return;
    }
    if (RECAPTCHA_SITE_KEY && !state.recaptchaToken) {
      const recaptchaBox = event.target.querySelector(".g-recaptcha");
      const captchaLoaded = Boolean(recaptchaBox?.querySelector("iframe"));
      setAuthErrorKey("signup", captchaLoaded ? "recaptchaMissing" : "recaptchaLoading");
      render();
      return;
    }
    state.authSubmitting = "signup";
    render();
    try {
      const data = await apiRequest("/api/auth/check-email", {
        method: "POST",
        body: JSON.stringify({ email: state.email }),
      });
      if (data.exists) {
        state.authSubmitting = "";
        setAuthErrorKey("signup", "emailExists", state.email);
        render();
        return;
      }
    } catch (error) {
      state.authSubmitting = "";
      setAuthErrorKey("signup", "emailCheckFailed");
      render();
      return;
    }
    try {
      await requestSignupOtp();
    } catch {
      state.authSubmitting = "";
      render();
      return;
    }
    state.authSubmitting = "";
    showStatusToast("Verification code sent.", state.email, true);
    render();
    return;
  }

  if (state.route === "root") {
    const rootEmail = String(form.get("username") || state.rootEmail || "").trim().toLowerCase();
    if (!rootEmail) {
      setAuthError("Enter the Super Admin email to continue.", "Root");
      render();
      return;
    }
    state.rootEmail = rootEmail;
    if (state.rootAuthStep !== "secret") {
      const password = String(form.get("current-password") || state.password || "");
      if (!password) {
        setAuthError("Enter the root password to continue.", "Root");
        render();
        return;
      }
      state.rootPassword = password;
      state.password = "";
      state.authError = "";
      state.rootStepMotion = "forward";
      state.rootAuthStep = "secret";
      render();
      return;
    }

    const secretPhrase = String(form.get("rootSecretPhrase") || state.rootSecretPhrase || "").trim();
    const password = String(state.rootPassword || "");
    if (!password || !secretPhrase) {
      setAuthError("Enter the root secret phrase to continue.", "Root");
      render();
      return;
    }
    state.authSubmitting = "login";
    render();
    try {
      const data = await apiRequest("/api/auth/root-login", {
        method: "POST",
        body: JSON.stringify({ email: rootEmail, password, secretPhrase }),
      });
      writeRootSession(rootEmail);
      persistAuthSession(data, { email: rootEmail });
      state.authSubmitting = "";
      state.rootAuthStep = "password";
      state.rootPassword = "";
      state.rootSecretPhrase = "";
      state.rootStepMotion = "";
      addActivity("AUTH", `${state.user.role} passed root authentication`, state.user.name);
      navigate(isSuperAdmin() ? "admin" : "root");
      return;
    } catch (error) {
      state.authSubmitting = "";
      setAuthError(error.message || "Root authentication failed.");
      render();
      return;
    }
  }

  const email = String(form.get("username") || state.email || "user@nexa.local").trim().toLowerCase();
  const password = String(form.get("current-password") || state.password || "");
  if (!email || !password) {
    if (email && !password) {
      setAuthError("This account may have been created with Google. Use Continue with Google, or reset your password to enable email login.", "Login");
    } else {
      setAuthErrorKey("login", "missingCredentials");
    }
    render();
    return;
  }
  state.authSubmitting = "login";
  render();
  try {
    const data = await apiRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    persistAuthSession(data, { email });
    state.authSubmitting = "";
    addActivity("AUTH", `${state.user.role} signed in with Supabase`, state.user.name);
    navigate(hasAdminAccess() ? "admin" : "dashboard");
    return;
  } catch (error) {
    state.authSubmitting = "";
    if (isGoogleOnlyLoginError(error)) {
      setAuthError("Use Continue with Google for this account, or reset your password to enable email login.", "Login");
      render();
      return;
    }
    if (error.status && error.status !== 502 && error.status !== 503) {
      if (/pending|approval/i.test(error.message || "")) setAuthErrorKey("login", "pendingApproval");
      else if (/suspend/i.test(error.message || "")) setAuthErrorKey("login", "suspended");
      else setAuthErrorKey("login", "invalidCredentials");
      render();
      return;
    }
    setAuthErrorKey("login", "backendUnavailable");
    render();
    return;
  }
}

async function completeProfileSetup(event) {
  // The role chosen on the profile screen determines the fields saved into Supabase.
  event.preventDefault();
  if (state.authSubmitting === "profile") return;
  const form = new FormData(event.target);
  const role = state.profileRole === "admin" ? "Admin" : state.profileRole === "staff" ? "Staff" : "Student";
  const firstName = String(form.get("firstName") || state.firstName || "").trim();
  const lastName = String(form.get("lastName") || state.lastName || "").trim();
  const staffFullName = String(form.get("fullName") || "").trim();
  const fullName = role === "Student" ? `${firstName} ${lastName}`.trim() : staffFullName;
  const name = fullName || "Nexaa User";
  if (role === "Student" && (!fullName || name === "Nexaa User")) {
    setAuthErrorKey("profile", "missingStudentName");
    render();
    return;
  }
  const matricNumber = String(form.get("matricNumber") || state.matricNumber || "").trim().toUpperCase();
  if (role === "Student" && !matricNumber) {
    setAuthErrorKey("profile", "missingMatricNumber");
    render();
    return;
  }
  if (role === "Student" && !/^ARE\/\d{2}\/\d{4}$/.test(matricNumber)) {
    setAuthError("Matric number must follow this format: ARE/00/0000.", "Student details");
    render();
    return;
  }
  if (role === "Student" && !String(form.get("level") || state.studentLevel || "").trim()) {
    setAuthErrorKey("profile", "missingLevel");
    render();
    return;
  }
  if (role !== "Student" && (!fullName || name === "Nexaa User")) {
    setAuthErrorKey("profile", "missingStaffName");
    render();
    return;
  }
  const submittedStaffPhrase = String(form.get("staffVerificationPhrase") || form.get("staffId") || "").trim();
  const submittedStaffEmail = String(form.get("staffReviewContact") || form.get("staffEmail") || "").trim();
  if (role !== "Student" && !submittedStaffPhrase) {
    setAuthErrorKey("profile", "missingStaffId");
    render();
    return;
  }
  const useGoogleSignup = Boolean(state.googleProfile && (state.googleAccessToken || state.googleCredential));

  state.user = {
    name,
    email: state.email || "user@nexa.local",
    role,
    department: DEPARTMENT_NAME,
    matricNumber: role === "Student" ? matricNumber : "",
    level: role === "Student" ? String(form.get("level") || "100L") : "",
    staffId: role !== "Student" ? submittedStaffPhrase.toUpperCase() : "",
    staffEmail: role !== "Student" ? submittedStaffEmail.toLowerCase() : "",
    title: role === "Staff" ? String(form.get("staffTitle") || "").trim() : role === "Admin" ? String(form.get("adminScope") || "").trim() : "",
    status: role === "Student" ? "active" : "pending",
  };
  if (role !== "Student" && !/@futa\.edu\.ng$/i.test(state.user.staffEmail)) {
    setAuthErrorKey("signup", "futaStaffEmailRequired");
    render();
    return;
  }
  if (role === "Staff" && String(state.user.staffId || "").trim().toUpperCase() !== STAFF_VERIFICATION_PHRASE) {
    setAuthError("The staff verification phrase is incorrect.", "Staff verification");
    render();
    return;
  }
  if (useGoogleSignup) {
    state.googlePendingProfile = { ...state.user };
    state.authError = "";
    state.authStep = "password";
    render();
    return;
  }
  state.isStaff = role === "Staff" && state.user.status !== "pending";
  state.authError = "";
  state.authSubmitting = "profile";
  render();
  try {
    const useVerifiedOtpSignup = Boolean(state.signupAccessToken || state.signupOtpDelivery === "gmail");
    const data = useVerifiedOtpSignup
      ? await apiRequest("/api/auth/complete-otp-signup", {
        method: "POST",
        body: JSON.stringify({
          email: state.user.email,
          accessToken: state.signupAccessToken,
          refreshToken: state.signupRefreshToken,
          password: state.password,
          profile: state.user,
        }),
      })
      : await apiRequest("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email: state.user.email,
          password: state.password,
          profile: state.user,
        }),
    });
    if (data.requiresEmailConfirmation) {
      state.authSubmitting = "";
      state.authStep = "credentials";
      state.authMode = "login";
      setAuthErrorKey("signup", "emailConfirmationRequired", state.user.email);
      showStatusToast("Account created. Check your email.", state.user.email, true);
      addActivity("AUTH", `${role} Supabase account awaiting email confirmation`, name);
      render();
      return;
    }
    persistAuthSession(data, state.user);
    state.authSubmitting = "";
    clearAuthDraftFields();
    addActivity("AUTH", `${state.user.role} Supabase profile completed`, state.user.name);
    showStatusToast(state.user.status === "pending" ? "Request submitted for approval" : "Account created successfully", state.user.email, true);
    navigate(hasAdminAccess() ? "admin" : "dashboard");
    return;
  } catch (error) {
    state.authSubmitting = "";
    const rawMessage = String(error.message || "");
    console.warn("Profile setup failed:", rawMessage, error);
    const message = /already|registered|exists/i.test(rawMessage)
      ? "This email already exists. Use Continue with Google if you created it with Google, or reset your password for email login."
      : rawMessage && rawMessage !== "Backend request failed"
        ? rawMessage
        : role === "Student" ? errorMessage("signup", "accountCreationFailed") : errorMessage("profile", "staffRequestFailed");
    setAuthError(message, state.user.email);
    render();
  }
}

async function completeGooglePasswordSetup(event) {
  event.preventDefault();
  if (state.authSubmitting === "profile") return;
  const form = new FormData(event.target);
  const profile = state.googlePendingProfile || state.user;
  const password = String(form.get("googlePassword") || "");
  const confirm = String(form.get("googlePasswordConfirm") || "");
  if (!profile || !state.googleProfile || (!state.googleAccessToken && !state.googleCredential)) {
    state.authStep = "profile";
    setAuthError("Complete account details before creating your password.", "Google signup");
    render();
    return;
  }
  if (password.length < 8) {
    setAuthError("Create a password with at least 8 characters for this Google account.", "Create password");
    render();
    return;
  }
  if (password !== confirm) {
    setAuthError("The passwords do not match. Please confirm the same password.", "Create password");
    render();
    return;
  }
  state.authError = "";
  state.authSubmitting = "profile";
  render();
  try {
    const data = await apiRequest("/api/auth/google-complete", {
      method: "POST",
      body: JSON.stringify({
        accessToken: state.googleAccessToken,
        credential: state.googleCredential,
        password,
        profile,
      }),
    });
    persistAuthSession(data, profile);
    state.authSubmitting = "";
    clearAuthDraftFields();
    addActivity("AUTH", `${state.user.role} Google profile completed`, state.user.name);
    showStatusToast(state.user.status === "pending" ? "Request submitted for approval" : "Account created successfully", state.user.email, true);
    navigate(hasAdminAccess() ? "admin" : "dashboard");
  } catch (error) {
    state.authSubmitting = "";
    const rawMessage = String(error.message || "");
    console.warn("Google password setup failed:", rawMessage, error);
    const message = /already|registered|exists/i.test(rawMessage)
      ? "This email already exists. Use Continue with Google if you created it with Google, or reset your password for email login."
      : rawMessage && rawMessage !== "Backend request failed"
        ? rawMessage
        : errorMessage("profile", "staffRequestFailed");
    setAuthError(message, profile.email || "Google signup");
    render();
  }
}

function signOut() {
  if (state.user) addActivity("AUTH", `${state.user.name} signed out`, state.user.role);
  removeSupabaseChannels();
  state.user = null;
  state.session = null;
  state.liveArchive = { loaded: false, loading: false, error: "", projects: [], materials: [], savedIds: [], notifications: [] };
  state.liveAdmin = { loaded: false, loading: false, error: "", stats: null, users: [], staffIds: [], uploads: [], notifications: [], rootSettings: null };
  clearAuthDraftFields();
  clearRootSession();
  localStorage.removeItem("nexaa-user");
  localStorage.removeItem("nexaa-session");
  sessionStorage.removeItem("nexaa-session");
  navigate("home");
}

function upsertUser(user) {
  appData = readData();
  const email = String(user.email || "").toLowerCase();
  const existingIndex = appData.users.findIndex((item) => item.email.toLowerCase() === email);
  const record = {
    name: user.name,
    email: user.email,
    role: user.role || "Student",
    status: user.status || "Active",
    staffEmail: user.staffEmail || "",
    matricNumber: user.matricNumber || "",
    staffId: user.staffId || "",
    level: user.level || "",
    department: user.department || DEPARTMENT_NAME,
    lastSeen: new Date().toISOString(),
  };
  if (existingIndex >= 0) appData.users[existingIndex] = { ...appData.users[existingIndex], ...record };
  else appData.users.unshift({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...record });
  writeData(appData);
}

function addActivity(type, message, actor = currentName()) {
  appData = readData();
  appData.activity.unshift({
    id: crypto.randomUUID(),
    type,
    actor,
    message,
    at: new Date().toISOString(),
  });
  appData.activity = appData.activity.slice(0, 60);
  writeData(appData);
}

function adminStats() {
  if (state.liveAdmin.loaded && state.liveAdmin.stats) return state.liveAdmin.stats;
  appData = readData();
  const admins = appData.users.filter((user) => user.role === "Super Admin" || user.role === "Admin").length + 1;
  return {
    totalUsers: appData.users.length + 1,
    students: appData.users.filter((user) => user.role === "Student").length,
    staff: state.liveStaff.loaded ? state.liveStaff.staff.length : appData.users.filter((user) => user.role === "Staff").length,
    admins,
    projects: archiveProjects().length,
    materials: archiveMaterials().length,
    pending: staffWorkspaceUploads(true).filter((item) => item.status === "Pending Review").length,
  };
}

function mobileDrawer({ dashboard = false, admin = false } = {}) {
  if (!state.menuOpen) return "";
  const drawerScrim = `<button class="mobile-drawer-scrim" data-action="toggleMenu" aria-label="Close mobile navigation"></button>`;
  const drawerProfile = state.user
    ? `<div class="mobile-drawer-profile">
        ${navAvatar()}
        <strong>${escapeHtml(currentName())}</strong>
        <span>${escapeHtml(displayRole())}</span>
      </div>`
    : "";
  if (admin) {
    return `${drawerScrim}<div class="mobile-drawer" role="dialog" aria-label="Mobile admin navigation">
      ${drawerProfile}
      ${isSuperAdmin() ? `
        <button data-route="admin">${icons.grid}<span>Dashboard</span></button>
        <button data-route="sentinel">${icons.shield}<span>Sentinel</span></button>
        <button data-admin-command="messages">${icons.mail}<span>Messages</span></button>
        <button data-admin-command="root-control">${icons.terminal}<span>Root</span></button>
        <button data-admin-command="admin-panel">${icons.users}<span>People</span></button>
        <button data-admin-command="reviews">${icons.clock}<span>Reviews</span></button>
        <button data-admin-command="audit-log">${icons.clipboard}<span>Audit</span></button>
      ` : `
        <button data-admin-command="overview">${icons.grid}<span>Dashboard</span></button>
        <button data-admin-command="search-admin">${icons.search}<span>Search</span></button>
        <button data-admin-command="upload">${icons.upload}<span>Upload</span></button>
        <button data-admin-command="audit-log">${icons.clipboard}<span>Audit Log</span></button>
        <button data-admin-command="admin-panel">${icons.shield}<span>Admin</span></button>
      `}
      <button data-route="settings">${icons.settings}<span>Settings</span></button>
      <button data-route="settings">${icons.userPlus}<span>Account details</span></button>
      <button data-action="signOut">${icons.logout}<span>Sign Out</span></button>
    </div>`;
  }
  if (dashboard) {
    return `${drawerScrim}<div class="mobile-drawer" role="dialog" aria-label="Mobile navigation">
      ${drawerProfile}
      <button data-route="dashboard">${icons.grid}<span>Dashboard</span></button>
      <button data-route="projects">${icons.archive}<span>Projects</span></button>
      <button data-route="materials">${icons.book}<span>Materials</span></button>
      ${state.user?.role === "Student" ? `<button data-route="saved">${icons.library}<span>Saved</span></button>` : ""}
      <button data-route="search">${icons.search}<span>Search</span></button>
      <button data-route="settings">${icons.settings}<span>Settings</span></button>
      ${hasStaffWorkspaceAccess() ? `<button data-route="upload">${icons.upload}<span>Upload</span></button><button data-route="lecturer">${icons.shield}<span>Lecturer</span></button>` : ""}
      <button data-route="settings">${icons.userPlus}<span>Account details</span></button>
      <button data-action="signOut">${icons.logout}<span>Sign Out</span></button>
    </div>`;
  }
  return `${drawerScrim}<div class="mobile-drawer public-drawer" role="dialog" aria-label="Mobile navigation">
    <button data-route="projects">${icons.archive}<span>Projects</span></button>
    <button data-route="materials">${icons.book}<span>Materials</span></button>
    <button data-route="search">${icons.search}<span>Search</span></button>
    <hr />
    <button class="drawer-sign-in" data-route="login">${icons.login}<span>Sign In</span></button>
  </div>`;
}

function notificationCenter() {
  if (!state.user || !state.notificationOpen) return "";
  const notes = notificationsForUser();
  return `<div class="notification-layer" role="presentation">
    <button class="notification-scrim" data-action="closeNotifications" aria-label="Close notifications"></button>
    <aside class="notification-center" role="dialog" aria-modal="true" aria-label="Notifications">
      <div class="notification-head">
        <div><strong>Notifications</strong><span>${notes.length} updates</span></div>
        <button class="notification-refresh" type="button" data-action="refreshNotifications" aria-label="Refresh notifications">${icons.refresh}</button>
        <button data-action="toggleNotifications" aria-label="Close notifications">${icons.x}</button>
      </div>
      <div class="notification-list">
        ${notes.length ? notes.map((note) => `<article>
          <span>${note.icon}</span>
          <div><strong>${escapeHtml(note.title)}</strong><p>${escapeHtml(note.body)}</p><small>${formatTime(note.at)}</small></div>
        </article>`).join("") : emptyState(icons.bell, "No notifications yet")}
      </div>
    </aside>
  </div>`;
}

function shell(content, { auth = false, dashboard = false, admin = false } = {}) {
  // Shared page chrome. Auth pages opt out so the login surface can stay full-screen.
  if (auth) return content;
  const notificationCount = state.user ? notificationsForUser().length : 0;
  const notificationBadge = notificationCount > 0 ? `<i>${notificationCount}</i>` : "";

  return `
    <header class="site-header${activeTourAnchor("nav")}">
      <div class="header-inner">
        <button class="brand brand-button" data-route="home" aria-label="Nexaa home">
          <span class="brand-icon" aria-hidden="true">${icons.archive}</span>
          <img src="./images/nexa-logo.png" alt="Nexaa" class="brand-logo" />
        </button>
        <nav class="desktop-nav" aria-label="Primary navigation">
          ${admin ? `
            ${isSuperAdmin() ? `
              <button class="${state.route === "admin" ? "active" : ""}" data-route="admin">Dashboard</button>
              <button class="${state.route === "sentinel" ? "active" : ""}" data-route="sentinel">Sentinel</button>
            ` : `
              <button class="${state.adminView === "overview" ? "active" : ""}" data-admin-command="overview">Dashboard</button>
              <button class="${state.adminView === "search-admin" ? "active" : ""}" data-admin-command="search-admin">Search</button>
              <button class="${state.adminView === "upload" ? "active" : ""}" data-admin-command="upload">Upload</button>
              <button class="${state.adminView === "audit-log" ? "active" : ""}" data-admin-command="audit-log">Audit Log</button>
              <button class="${state.adminView === "admin-panel" || state.adminView === "users" ? "active" : ""}" data-admin-command="admin-panel">Admin</button>
            `}
          ` : `
            ${dashboard ? `<button class="${state.route === "dashboard" ? "active" : ""}" data-route="dashboard">Dashboard</button>` : ""}
            <button class="${state.route === "projects" ? "active" : ""}" data-route="${dashboard ? "projects" : "login"}">Projects</button>
            <button class="${state.route === "materials" ? "active" : ""}" data-route="${dashboard ? "materials" : "login"}">Materials</button>
            ${dashboard && roleSlug() === "student" ? `<button class="${state.route === "saved" ? "active" : ""}" data-route="saved">Saved</button>` : ""}
            <button class="${state.route === "search" ? "active" : ""}" data-route="${dashboard ? "search" : "login"}">Search</button>
            ${dashboard && hasStaffWorkspaceAccess() ? `<button class="${state.route === "upload" ? "active" : ""}" data-route="upload">Upload</button><button class="${state.route === "lecturer" ? "active" : ""}" data-route="lecturer">Lecturer</button>` : ""}
            ${dashboard && isRegularAdmin() && hasAdminAccess() ? `<button class="${state.route === "admin" ? "active" : ""}" data-route="admin">Admin</button>` : ""}
          `}
        </nav>
        ${dashboard || admin
          ? `<div class="account-bar">${admin ? `<span class="root-pill">${icons.terminal} ${isSuperAdmin() ? "ROOT" : "ADMIN"}</span>` : ""}<button class="notify-button ${state.notificationOpen ? "active" : ""}" data-action="toggleNotifications" aria-label="Notifications">${icons.bell}${notificationBadge}</button><button class="account-chip" data-route="settings">${navAvatar()}<span><b>${escapeHtml(currentName())}</b><small>${escapeHtml(displayRole())}</small></span></button><button class="settings-icon-button ${state.route === "settings" ? "active" : ""}" data-route="settings" aria-label="Settings">${icons.settings}</button><button class="header-action light" data-action="signOut">${icons.logout}<span>Sign Out</span></button></div>`
          : `<button class="sign-in" data-route="login">${icons.login}<span>Login / Sign Up</span></button>`}
        ${dashboard || admin ? `<button class="notify-button mobile-notify-button ${state.notificationOpen ? "active" : ""}" data-action="toggleNotifications" aria-label="Notifications">${icons.bell}${notificationBadge}</button>` : ""}
        <button class="menu-button ${state.menuOpen ? "active" : ""}" data-action="toggleMenu" aria-label="${state.menuOpen ? "Close menu" : "Open menu"}">
          ${state.menuOpen ? icons.x : icons.menu}
        </button>
      </div>
    </header>
    ${state.user ? `<input class="profile-file-input" type="file" name="profileImage" accept="image/*" data-profile-input aria-hidden="true" />` : ""}
    ${mobileDrawer({ dashboard, admin })}
    ${notificationCenter()}
    ${content}
    ${dashboard || admin ? tutorialOverlay() : ""}
    ${protectedViewerModal()}
    ${bookmarkToast()}
    ${isSuperAdmin() && (admin || state.route === "settings") ? "" : helpWidget()}
  `;
}

function landing() {
  return shell(`
    <main class="home-page">
      <section class="hero-section">
        <div class="glow glow-left" aria-hidden="true"></div>
        <div class="glow glow-right" aria-hidden="true"></div>
        <div class="glow glow-center" aria-hidden="true"></div>
        <div class="hero-blob hero-blob-primary" aria-hidden="true"></div>
        <div class="hero-blob hero-blob-accent" aria-hidden="true"></div>
        <div class="hero-blob hero-blob-center" aria-hidden="true"></div>
        <div class="hero-content">
          <div class="brand-pill">${icons.spark}<img src="./images/nexa-logo.png" alt="Nexaa" /></div>
          <h1 class="fade-up">Preserving <span class="gradient-text inline-block">Knowledge</span>.</h1>
          <p class="split-text">A permanent academic archive powering the next generation. Projects preserved. Materials organized. Knowledge accessible.</p>
          <form class="search-shell neon-search-box fade-up" data-action="search">
            <div class="search-card">
              <label class="search-input-wrap" for="archive-search">${icons.search}<input id="archive-search" name="archiveSearch" type="search" placeholder="Search projects, materials, past questions..." autocomplete="off" /></label>
              <button class="gradient-primary" type="submit">${icons.search}<span>Search</span></button>
            </div>
          </form>
        </div>
      </section>
      <section class="stats-section" aria-label="Archive statistics">
        <div class="container stats-grid">
          ${statCard("150+", "Projects Archived", icons.archive)}
          ${statCard("500+", "Learning Materials", icons.book)}
          ${statCard("10+", "Years Covered", icons.spark)}
          ${statCard("200+", "Contributors", icons.users)}
        </div>
      </section>
      <section class="inside-section">
        <div class="container">
          <div class="section-heading"><h2>What's Inside</h2><p>A structured system for academic preservation and access</p></div>
          <div class="feature-grid">
            ${featureCard("Project Archive", "Final year projects with full metadata, abstracts, keywords, and physical location mapping.", icons.archive, "projects")}
            ${featureCard("Learning Materials", "Past questions, lecture notes, slides, guidelines, and reference documents organized by course.", icons.book, "materials")}
            ${featureCard("Smart Search", "Find any document instantly with multi-filter search across all archived content.", icons.search, "search")}
          </div>
        </div>
      </section>
      <section class="cta-section">
        <div class="container cta-wrap">
          <div class="glass-card cta-card">
            <div class="cta-glow" aria-hidden="true"></div>${icons.spark}
            <h2>Ready to Explore?</h2>
            <p>Dive into a decade of academic knowledge, preserved for the future.</p>
            <button class="cta-button" data-route="login"><span>Get Started</span>${icons.arrowRight}</button>
          </div>
        </div>
      </section>
    </main>
    <footer class="landing-footer">
      <div class="container">
        <div class="landing-footer-brand"><img src="./images/nexa-logo.png" alt="NEXA" /><span>Academic Archive &amp; Resource System</span></div>
        <p>Preserving Knowledge. Powering the Next.</p>
      </div>
    </footer>
  `);
}

function statCard(value, label, icon) {
  return `<article class="glass-card stat-card">${icon}<strong>${value}</strong><span>${label}</span></article>`;
}

function featureCard(title, desc, icon, route) {
  return `
    <button class="glass-card feature-card" data-route="${route}">
      <div class="feature-title"><h3>${title}</h3>${icon}</div>
      <p>${desc}</p>
      <span>Explore <b aria-hidden="true">&rsaquo;</b></span>
    </button>
  `;
}

function authFlow() {
  // Login/signup/profile setup share one card so transitions and autofill handling stay consistent.
  const banner = banners[state.bannerIndex];
  const bannerElapsed = Math.min(Math.max(Date.now() - Number(state.bannerCycleStartedAt || Date.now()), 0), BANNER_CYCLE_MS);
  const isLogin = state.authMode === "login";
  const isProfileSetup = state.authMode === "signup" && state.authStep === "profile";
  const isPasswordSetup = state.authMode === "signup" && state.authStep === "password";
  const isSignupOtp = state.authMode === "signup" && state.authStep === "verify-signup";
  const isRoleSelection = state.authMode === "signup" && state.authStep === "role";
  const isSetupLoading = state.authMode === "signup" && state.authStep === "setup-loading";
  const isPostAuthStep = isSignupOtp || isRoleSelection || isProfileSetup || isPasswordSetup || isSetupLoading;
  const isStaffProfile = state.profileRole === "staff";
  const isAdminProfile = state.profileRole === "admin";
  const otpCooldown = signupOtpCooldownSeconds();
  const otpResendDisabled = state.signupOtpResending || otpCooldown > 0 || state.signupOtpResends >= 3;
  const otpResendLabel = state.signupOtpResending
    ? "Sending..."
    : state.signupOtpResends >= 3 ? "Resend limit reached" : otpCooldown > 0 ? `Resend in ${otpCooldown}s` : "Didn't receive OTP? Resend";
  const emailField = `<label>Email<input name="username" type="email" value="${escapeHtml(state.email)}" placeholder="Email" autocomplete="username" autocapitalize="none" spellcheck="false" data-private-input readonly required /></label>`;
  return shell(`
    <main class="auth-page ${isPostAuthStep ? "auth-page-post-auth" : ""} ${isSignupOtp ? "auth-page-otp-only" : ""}">
      ${isPostAuthStep ? "" : `<section class="auth-media" style="--banner-image: url('${banner.image}')">
        <div class="auth-media-shade"></div>
        <button class="auth-logo" data-route="home"><img src="./images/nexa-logo.png" alt="Nexaa" /></button>
          <div class="slide-copy">
            <div class="slide-icon">${banner.icon}</div>
            <h1>${banner.title}</h1>
            <p>${banner.subtitle}</p>
            <div class="slide-dots">
            ${banners.map((_, index) => `<button type="button" class="${index === state.bannerIndex ? "active" : ""}" ${index === state.bannerIndex ? `style="--banner-progress-delay: -${bannerElapsed}ms"` : ""} data-banner="${index}" aria-label="Show banner ${index + 1}"></button>`).join("")}
          </div>
        </div>
      </section>`}
      <section class="auth-panel-wrap">
        <div class="auth-panel ${state.authFlipClass ? `auth-flip-${state.authFlipClass}` : ""} ${isLogin ? "auth-panel-login" : "auth-panel-signup"} ${isPostAuthStep ? "auth-panel-post-auth" : ""} ${isProfileSetup ? "auth-panel-profile" : ""} ${isPasswordSetup ? "auth-panel-password" : ""} ${isSignupOtp ? "auth-panel-otp" : ""} ${isRoleSelection ? "auth-panel-role" : ""} ${isStaffProfile && isProfileSetup ? "auth-panel-staff" : ""}">
          ${!isPostAuthStep ? `<div class="auth-toggle">
            <button type="button" class="${isLogin ? "active" : ""}" data-mode="login">${icons.login}<span>Login</span></button>
            <button type="button" class="${!isLogin ? "active" : ""}" data-mode="signup">${icons.userPlus}<span>Sign Up</span></button>
          </div>` : ""}
          ${isSetupLoading ? `
          <div class="setup-loading-state">
            <div class="app-loader-mark" aria-hidden="true"><span></span><i></i></div>
            <h2>Setting things up</h2>
            <p>Preparing your account steps...</p>
          </div>
          ` : `<div class="auth-heading">
            <h2>${isPasswordSetup ? "Create Password" : isProfileSetup ? (isAdminProfile ? "Admin Request" : isStaffProfile ? "Staff Verification" : "Student Profile") : isRoleSelection ? "Choose Your Role" : isSignupOtp ? "Verify Email" : isLogin ? "Welcome Back" : "Join Nexaa"}</h2>
            <p>${isPasswordSetup ? "Set a private Nexaa password in a separate secure step" : isProfileSetup ? (isAdminProfile ? "Admin access needs Super Admin approval before privileges unlock" : isStaffProfile ? "Input your staff details for review by administrator" : "Enter your name, matric number, and current level") : isRoleSelection ? "Pick the account type that matches how you will use Nexaa" : isSignupOtp ? "Enter the code sent to your Gmail to continue" : isLogin ? "Login to access the archive" : "Create your account to get started"}</p>
          </div>`}
          ${!isProfileSetup && !isPasswordSetup && !isSignupOtp && !isRoleSelection && !isSetupLoading ? `
            <div class="gmail-button-host" data-google-button>
              <button class="gmail-button" type="button" data-action="gmailAuth"><span class="google-mark" aria-hidden="true">${googleLogo}</span> Continue with Google</button>
            </div>
            <div class="auth-divider"><span>or</span></div>
          ` : ""}
          ${isSetupLoading ? "" : isRoleSelection ? `
          <div class="account-type-choice auth-role-step">
            <span>Account type</span>
            <div class="auth-role-toggle auth-role-cards two" aria-label="Choose account type">
              <button type="button" class="${state.profileRole === "student" ? "active" : ""}" data-action="selectStudent">${roleInlineIcon(icons.cap)}<span><strong>Student</strong><small>Matric number and level</small></span><i>${state.profileRole === "student" ? icons.check : ""}</i></button>
              <button type="button" class="${state.profileRole === "staff" ? "active" : ""}" data-action="selectStaff">${roleInlineIcon(icons.staff)}<span><strong>Staff</strong><small>FUTA staff email review</small></span><i>${state.profileRole === "staff" ? icons.check : ""}</i></button>
            </div>
          </div>
          <button class="auth-submit" type="button" data-action="continueRoleSetup">${icons.login}<span>Continue</span></button>
          ` : isPasswordSetup ? `
          <form class="auth-form google-password-form" data-google-password-form>
            <p class="auth-inline-note">Your staff verification details are saved for this signup step. Create a password so you can sign in later without exposing it on the profile form.</p>
            <label>New Password<input name="googlePassword" type="password" placeholder="Create password" autocomplete="new-password" data-private-input required minlength="8" /></label>
            <label>Confirm Password<input name="googlePasswordConfirm" type="password" placeholder="Confirm password" autocomplete="new-password" data-private-input required minlength="8" /></label>
            ${submitButton("profile", icons.shield, "Create Password")}
            <button class="auth-back" type="button" data-action="backToProfileSetup">Back to staff verification</button>
          </form>
          ` : isProfileSetup ? `
          ${isAdminProfile ? `<div class="account-type-choice">
            <span>Admin account</span>
          </div>` : ""}
          <form class="auth-form" data-profile-form>
            ${isStaffProfile ? `
              <label>Full Name<input name="fullName" value="${escapeHtml(state.staffFullName)}" placeholder="Enter full name" autocomplete="off" required /></label>
              <label>FUTA Staff Email<input name="staffReviewContact" type="text" inputmode="email" value="${escapeHtml(state.staffEmail)}" placeholder="name@futa.edu.ng" autocomplete="new-password" autocapitalize="none" spellcheck="false" data-staff-review-field required /></label>
              <label>Staff Verification Phrase<input name="staffVerificationPhrase" type="text" value="${escapeHtml(state.staffId)}" placeholder="Enter verification phrase" autocomplete="new-password" autocapitalize="none" spellcheck="false" data-staff-review-field required /></label>
              <div class="two-col auth-staff-row">
                <label>Department<input name="department" value="${escapeHtml(DEPARTMENT_NAME)}" placeholder="Department" readonly aria-readonly="true" required /></label>
                <label>Staff Role<input name="staffTitle" value="${escapeHtml(state.staffTitle)}" placeholder="Enter staff role" autocomplete="off" /></label>
              </div>
            ` : isAdminProfile ? `
              <label>Full Name<input name="fullName" value="${escapeHtml(state.staffFullName)}" placeholder="Enter full name" autocomplete="off" required /></label>
              <label>FUTA Staff Email<input name="staffReviewContact" type="text" inputmode="email" value="${escapeHtml(state.staffEmail)}" placeholder="name@futa.edu.ng" autocomplete="new-password" autocapitalize="none" spellcheck="false" data-staff-review-field required /></label>
              <div class="two-col auth-staff-row">
                <label>Staff/Admin ID<input name="staffId" value="${escapeHtml(state.staffId)}" placeholder="ADM-2026-001" autocomplete="off" required /></label>
                <label>Admin Scope<input name="adminScope" value="${escapeHtml(state.adminScope)}" placeholder="Enter admin scope" autocomplete="off" required /></label>
              </div>
              <label>Department<input name="department" value="${escapeHtml(DEPARTMENT_NAME)}" placeholder="Department" readonly aria-readonly="true" required /></label>
            ` : `
              <div class="two-col">
                <label>First Name<input name="firstName" value="${escapeHtml(state.firstName)}" placeholder="First Name" autocomplete="given-name" required /></label>
                <label>Last Name<input name="lastName" value="${escapeHtml(state.lastName)}" placeholder="Last Name" autocomplete="family-name" required /></label>
              </div>
              <div class="two-col">
                <label>Matric Number<input name="matricNumber" value="${escapeHtml(state.matricNumber)}" placeholder="ARE/00/0000" autocomplete="off" pattern="ARE/[0-9]{2}/[0-9]{4}" title="Use ARE/00/0000 format" required /></label>
                <label>Level<span class="select-wrap"><select name="level" required>${materialLevels.map((level) => `<option value="${level}" ${state.studentLevel === level ? "selected" : ""}>${level}</option>`).join("")}</select>${icons.chevronDown}</span></label>
              </div>
            `}
            ${submitButton("profile", icons.userPlus, "Finish Setup")}
            <button class="auth-back" type="button" data-action="backToRole">Back to role selection</button>
          </form>
          ` : isSignupOtp ? `
          <form class="auth-form" data-signup-otp-form>
            <p class="auth-inline-note">We sent a 6-digit verification code to <strong>${escapeHtml(state.email)}</strong>.</p>
            <label>OTP Code<input name="signupOtp" inputmode="numeric" maxlength="6" value="${escapeHtml(state.signupOtpInput)}" placeholder="000000" autocomplete="one-time-code" required /></label>
            ${submitButton("verify-otp", icons.shield, "Verify Email")}
            <button class="auth-back auth-resend" type="button" data-action="resendSignupOtp" ${otpResendDisabled ? "disabled" : ""}>${escapeHtml(otpResendLabel)}</button>
          </form>
          ` : `
          <form class="auth-form" data-auth-form>
            ${emailField}
            <label>
              <span class="password-label">Password ${isLogin ? `<button type="button" data-action="forgot">Forgot password?</button>` : ""}</span>
              <span class="password-wrap">
                <input name="current-password" type="${state.showPassword ? "text" : "password"}" placeholder="Password" autocomplete="current-password" data-private-input data-auth-password readonly required minlength="8" />
                <button type="button" data-action="togglePassword" aria-label="Toggle password visibility">${state.showPassword ? icons.eyeOff : icons.eye}</button>
              </span>
            </label>
            ${submitButton(isLogin ? "login" : "signup", isLogin ? icons.login : icons.userPlus, isLogin ? "Sign In" : "Create Account")}
            ${!isLogin ? recaptchaMarkup() : ""}
          </form>
          `}
          <div class="auth-foot">${icons.spark}<span>Preserving Knowledge. Powering the Next.</span></div>
        </div>
      </section>
    </main>
    ${resetPasswordModal()}
    ${helpWidget()}
    ${bookmarkToast()}
  `, { auth: true });
}

function authCredentialsPanelMarkup() {
  const isLogin = state.authMode === "login";
  const emailField = `<label>Email<input name="username" type="email" value="${escapeHtml(state.email)}" placeholder="Email" autocomplete="username" autocapitalize="none" spellcheck="false" data-private-input readonly required /></label>`;
  return `<div class="auth-panel ${state.authFlipClass ? `auth-flip-${state.authFlipClass}` : ""} ${isLogin ? "auth-panel-login" : "auth-panel-signup"}">
    <div class="auth-toggle">
      <button type="button" class="${isLogin ? "active" : ""}" data-mode="login">${icons.login}<span>Login</span></button>
      <button type="button" class="${!isLogin ? "active" : ""}" data-mode="signup">${icons.userPlus}<span>Sign Up</span></button>
    </div>
    <div class="auth-heading">
      <h2>${isLogin ? "Welcome Back" : "Join Nexaa"}</h2>
      <p>${isLogin ? "Login to access the archive" : "Create your account to get started"}</p>
    </div>
    <div class="gmail-button-host" data-google-button>
      <button class="gmail-button" type="button" data-action="gmailAuth"><span class="google-mark" aria-hidden="true">${googleLogo}</span> Continue with Google</button>
    </div>
    <div class="auth-divider"><span>or</span></div>
    <form class="auth-form" data-auth-form>
      ${emailField}
      <label>
        <span class="password-label">Password ${isLogin ? `<button type="button" data-action="forgot">Forgot password?</button>` : ""}</span>
        <span class="password-wrap">
          <input name="current-password" type="${state.showPassword ? "text" : "password"}" placeholder="Password" autocomplete="current-password" data-private-input data-auth-password readonly required minlength="8" />
          <button type="button" data-action="togglePassword" aria-label="Toggle password visibility">${state.showPassword ? icons.eyeOff : icons.eye}</button>
        </span>
      </label>
      ${submitButton(isLogin ? "login" : "signup", isLogin ? icons.login : icons.userPlus, isLogin ? "Sign In" : "Create Account")}
      ${!isLogin ? recaptchaMarkup() : ""}
    </form>
    <div class="auth-foot">${icons.spark}<span>Preserving Knowledge. Powering the Next.</span></div>
  </div>`;
}

function renderAuthPanelOnly() {
  const panel = document.querySelector(".auth-panel");
  if (!panel || state.route !== "login" || state.authStep !== "credentials") return false;
  panel.outerHTML = authCredentialsPanelMarkup();
  requestAnimationFrame(mountGoogleButton);
  requestAnimationFrame(mountRecaptcha);
  requestAnimationFrame(blankPrivateVisibleFields);
  requestAnimationFrame(scheduleAuthErrorAutoClear);
  window.setTimeout(blankPrivateVisibleFields, 60);
  window.setTimeout(blankPrivateVisibleFields, 220);
  return true;
}

function resetPasswordModal() {
  if (!state.resetOpen) return "";
  const email = escapeHtml(state.resetEmail || state.email || "your email");
  return `<div class="modal-layer" role="presentation">
    <button class="modal-scrim" data-action="closeReset" aria-label="Close reset dialog"></button>
    <section class="reset-modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
      <button class="modal-close" data-action="closeReset" aria-label="Close reset dialog">&times;</button>
      <h2 id="reset-title">Reset Password</h2>
      ${state.resetStep === "request" ? `
        <p>Enter your email and we will send a password reset link.</p>
        <form data-reset-form>
          <label>Email<input name="resetEmail" type="email" value="${escapeHtml(state.resetEmail || state.email)}" placeholder="Email" required />${fieldErrorMarkup(state.resetError)}</label>
          ${submitButton("reset-link", icons.login, "Send Reset Link")}
        </form>`
        : state.resetStep === "link-sent" ? `
          <p>We sent a reset link to <strong>${email}</strong>. Open it to create a new password.</p>
          <div class="email-delivery"><span>Email delivery</span><p>Check your inbox for the password reset link.</p></div>
          <button class="auth-submit" data-action="closeReset" type="button">Done</button>`
        : state.resetStep === "new-password" ? `
          <p>Create a new password for <strong>${email}</strong>.</p>
          <form data-new-password-form>
            <label>New Password<input name="newPassword" type="password" placeholder="New password" autocomplete="new-password" data-private-input required minlength="8" /></label>
            <label>Confirm Password<input name="confirmPassword" type="password" placeholder="Confirm password" autocomplete="new-password" data-private-input required minlength="8" />${fieldErrorMarkup(state.resetError)}</label>
            ${submitButton("reset-password", icons.shield, "Update Password")}
          </form>`
        : `
          <p class="reset-success">Password updated for <strong>${email}</strong>. You can now sign in with the new password.</p>
          <button class="auth-submit" data-action="closeReset" type="button">Done</button>`}
    </section>
  </div>`;
}

const tourSteps = [
  { title: "Welcome to Nexa", body: "Your academic workspace for projects, materials, and smart archive search. Let's show you around quickly.", button: "Next", anchor: "blank", arrow: "none" },
  { title: "Use the Navigation Menu", body: "Switch between Dashboard, Projects, Materials, and Search anytime using the top navigation bar.", button: "Next", anchor: "nav", arrow: "nav" },
  { title: "Search Anything Instantly", body: "Use the search bar to quickly find projects, materials, authors, or keywords across the archive.", button: "Next", anchor: "search", arrow: "search" },
  { title: "Track Your Activity", body: "These cards show your total projects bookmarked and saved for later and available materials at a glance.", button: "Next", anchor: "stats", arrow: "stats" },
  { title: "Quick Access Shortcuts", body: "Jump directly into browsing projects, opening course materials, or searching the archive from here.", button: "Next", anchor: "quick", arrow: "quick" },
  { title: "You're Ready", body: "Explore Nexa and start accessing academic resources faster and smarter.", button: "Enter Dashboard", anchor: "blank", arrow: "none" },
];

const roleTours = {
  staff: [
    { title: "Staff Workspace", body: "Upload projects and materials, then track each file through the review queue.", button: "Next", anchor: "hero", arrow: "hero" },
    { title: "Review Status", body: "Draft, submitted, pending, approved, and rejected states show exactly where each upload stands.", button: "Next", anchor: "stats", arrow: "stats" },
    { title: "Upload Shortcuts", body: "Start a project or material upload from the quick action cards.", button: "Enter Dashboard", anchor: "quick", arrow: "quick" },
  ],
  hod: [
    { title: "HOD Controls", body: "Review departmental submissions and manage staff access from one place.", button: "Next", anchor: "hero", arrow: "hero" },
    { title: "Department Queue", body: "Pending reviews and staff requests are separated so approvals stay traceable.", button: "Next", anchor: "stats", arrow: "stats" },
    { title: "Staff Management", body: "Approve staff requests, suspend access, and keep an audit trail.", button: "Enter Dashboard", anchor: "quick", arrow: "quick" },
  ],
  admin: [
    { title: "Admin Operations", body: "Manage archive users, reviews, content, and search without root customization controls.", button: "Next", anchor: "hero", arrow: "hero" },
    { title: "Audit Trail", body: "Every approval, rejection, suspension, upload, and admin command is recorded.", button: "Next", anchor: "stats", arrow: "stats" },
    { title: "Review Queue", body: "Use the review panel to publish or reject staff uploads with clear comments.", button: "Enter Dashboard", anchor: "quick", arrow: "quick" },
  ],
  "super-admin": [
    { title: "Root Control", body: "Super Admin has operational controls plus system customization and global admin settings.", button: "Next", anchor: "hero", arrow: "hero" },
    { title: "System Scope", body: "Track users, content, departments, and audit activity across the archive.", button: "Next", anchor: "stats", arrow: "stats" },
    { title: "Customize Safely", body: "Root-only controls are separated from everyday admin actions.", button: "Enter Dashboard", anchor: "quick", arrow: "quick" },
  ],
};

function currentTourSteps() {
  return roleTours[roleSlug()] || tourSteps;
}

function activeTourAnchor(anchor) {
  if (!state.tourActive || !shouldShowRoleOnboarding()) return "";
  const steps = currentTourSteps();
  const step = steps[state.tourStep] || steps[0];
  if (!step.anchor || step.anchor === "blank" || step.anchor === "none") return "";
  return step.anchor === anchor ? " tour-focus" : "";
}

function scrollTourFocusIntoView() {
  if (!state.tourActive || !shouldShowRoleOnboarding()) return;
  const step = currentTourSteps()[state.tourStep] || currentTourSteps()[0];
  if (!step?.anchor || step.anchor === "blank" || step.anchor === "none") {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const target = step.anchor === "nav"
    ? document.querySelector(".site-header")
    : document.querySelector(".tour-focus, [data-tour-anchor='" + CSS.escape(step.anchor) + "']");
  if (!target) return;
  const block = step.anchor === "nav" ? "start" : "center";
  target.scrollIntoView({ behavior: "smooth", block, inline: "nearest" });
}

function tutorialOverlay() {
  if (!state.tourActive || !shouldShowRoleOnboarding()) return "";
  const steps = currentTourSteps();
  const step = steps[state.tourStep] || steps[0];
  const isLast = state.tourStep >= steps.length - 1;
  return `<div class="tour-layer" data-anchor="${escapeHtml(step.anchor || "hero")}" data-arrow="${escapeHtml(step.arrow || "hero")}" role="dialog" aria-modal="true" aria-labelledby="tour-title">
    <div class="tour-scrim"></div>
    <section class="tour-card">
      <span>Step ${state.tourStep + 1} of ${steps.length}</span>
      <h2 id="tour-title">${escapeHtml(step.title)}</h2>
      <p>${escapeHtml(step.body)}</p>
      <div class="tour-actions">
        <button data-action="tourNext">${escapeHtml(isLast ? step.button : "Next")}</button>
      </div>
    </section>
  </div>`;
}

function bookmarkToast() {
  if (!state.bookmarkToast) return "";
  const toast = state.bookmarkToast;
  return `<aside class="bookmark-toast ${toast.saved ? "saved" : "removed"}" role="status" aria-live="polite">
    <span>${toast.saved ? icons.check : icons.bookmark}</span>
    <div>
      <strong>${escapeHtml(toast.message)}</strong>
      <p>${escapeHtml(toast.title)}</p>
    </div>
  </aside>`;
}

function protectedViewerModal() {
  if (!state.protectedViewerId) return "";
  const item = resourceById(state.protectedViewerId);
  if (!item) return "";
  const kind = resourceKind(item);
  const materialViewer = kind === "material";
  const year = item.year || "Archive";
  const abstractText = materialViewer
    ? `${item.courseTitle || item.title || "Course material"} is available as a protected academic resource in Nexaa.`
    : item.abstract || item.meta || "Abstract unavailable.";
  const viewerId = escapeHtml(resourceId(item));
  const doc = state.protectedViewerDocument;
  const pageCount = Math.max(1, Number(doc?.pageCount || 1));
  const currentPage = Math.min(Math.max(1, Number(state.protectedViewerPage || 1)), pageCount);
  const pageLabel = doc?.pages?.[currentPage - 1]?.label || `Page ${currentPage}`;
  return `<div class="protected-viewer-layer" data-protected-viewer role="dialog" aria-modal="true" aria-labelledby="protected-viewer-title">
    <button class="protected-viewer-scrim" type="button" data-action="closeProtectedViewer" aria-label="Close protected viewer"></button>
    <section class="protected-viewer-panel" tabindex="-1">
      <header class="protected-viewer-head">
        <div>
          <span class="viewer-lock-pill">${icons.shield}<b>View only</b></span>
          <h2 id="protected-viewer-title">${escapeHtml(item.title)}</h2>
          <p>${escapeHtml(item.type || item.category || "Protected project")} &middot; ${escapeHtml(year)}</p>
        </div>
        <button class="modal-close" type="button" data-action="closeProtectedViewer" aria-label="Close protected viewer">${icons.x}</button>
      </header>
      ${materialViewer ? `<div class="protected-viewer-meta">
        <span><b>Course Code</b>${escapeHtml(item.code || "ARE")}</span>
        <span><b>Level</b>${escapeHtml(item.level || "Material")}</span>
        <span><b>Type</b>${escapeHtml(materialTypeGroup(item))}</span>
        <span><b>Course</b>${escapeHtml(item.courseTitle || item.title)}</span>
      </div>` : `<div class="protected-viewer-meta">
        <span><b>Book ID</b>${escapeHtml(item.bookId || "ARE-000")}</span>
        <span><b>Cabinet</b>${escapeHtml(item.cabinet || "Cabinet A")}</span>
        <span><b>Row</b>${escapeHtml(item.row || "Row 1")}</span>
        <span><b>Column</b>${escapeHtml(item.column || "Column 1")}</span>
      </div>`}
      <div class="protected-viewer-body">
        <aside class="protected-viewer-abstract">
          <h3>${materialViewer ? "Material Info" : "Abstract"}</h3>
          <p>${escapeHtml(abstractText)}</p>
          ${materialViewer ? "" : `<button type="button" data-action="downloadAbstract" data-resource-id="${viewerId}">${icons.download}<span>Download Abstract</span></button>`}
        </aside>
        <div class="protected-document-frame" data-protected-document>
          <div class="protected-watermark">${escapeHtml(currentName())} &middot; ${escapeHtml(DEPARTMENT_NAME)}</div>
          ${state.protectedViewerLoading || state.protectedViewerPageLoading ? `<div class="protected-document-loading">${icons.spark}<strong>${state.protectedViewerLoading ? "Opening protected document..." : "Rendering protected page..."}</strong><span>Preparing secure image view</span></div>` : ""}
          ${state.protectedViewerError ? `<div class="protected-document-loading error">${icons.alert}<strong>Protected file unavailable</strong><span>${escapeHtml(state.protectedViewerError)}</span></div>` : ""}
          ${doc ? `<div class="protected-page-controls">
            <button type="button" data-action="protectedPrevPage" ${currentPage <= 1 ? "disabled" : ""}>${icons.chevronDown}<span>Prev</span></button>
            <strong>${escapeHtml(pageLabel)} of ${pageCount}</strong>
            <button type="button" data-action="protectedNextPage" ${currentPage >= pageCount ? "disabled" : ""}><span>Next</span>${icons.chevronDown}</button>
          </div>` : ""}
          ${state.protectedViewerPageImageUrl ? `<img class="protected-page-image" src="${state.protectedViewerPageImageUrl}" alt="${escapeHtml(pageLabel)} of ${escapeHtml(item.title)}" draggable="false" />` : `<article class="protected-document-page">
            <div class="document-page-head">
              <span>${escapeHtml(materialViewer ? materialTypeGroup(item) : item.category || "Project")}</span>
              <strong>${escapeHtml(materialViewer ? item.code || "ARE" : item.bookId || "ARE-000")}</strong>
            </div>
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(doc ? `${doc.originalName || "Protected file"} opened in page-by-page view.` : item.meta || "Department archive document")}</p>
            ${doc ? `<div class="protected-page-stamp"><span>${escapeHtml(pageLabel)}</span><b>${currentPage}</b></div>` : ""}
            <section>
              <h4>Chapter One</h4>
              <p>${escapeHtml(protectedViewerParagraph(item, "This document is available for supervised reading inside Nexaa. Use the physical archive location above for departmental access and citation checks."))}</p>
            </section>
            <section>
              <h4>Methodology</h4>
              <p>${escapeHtml(protectedViewerParagraph(item, "The archive viewer keeps project and proposal files readable without exposing download controls or copy actions for the full document."))}</p>
            </section>
            <section>
              <h4>Findings Summary</h4>
              <p>${escapeHtml(protectedViewerParagraph(item, "Consult the department archive for the approved hard copy and full supervised review record."))}</p>
            </section>
          </article>`}
        </div>
      </div>
    </section>
  </div>`;
}

function protectedViewerParagraph(item, fallback) {
  const source = item.abstract || item.meta || fallback;
  const cleaned = String(source).replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 180 ? `${cleaned.slice(0, 180).trim()}...` : cleaned;
}

function clearProtectedPageImage() {
  if (state.protectedViewerPageImageUrl) URL.revokeObjectURL(state.protectedViewerPageImageUrl);
  state.protectedViewerPageImageUrl = "";
}

async function loadProtectedViewerDocument(item) {
  if (!item?.backendFileId || !state.session?.access_token) {
    state.protectedViewerDocument = null;
    state.protectedViewerLoading = false;
    state.protectedViewerError = item?.backendFileId ? errorMessage("login", "sessionExpired") : "";
    render();
    return;
  }
  state.protectedViewerLoading = true;
  state.protectedViewerError = "";
  state.protectedViewerDocument = null;
  clearProtectedPageImage();
  render();
  try {
    const data = await apiRequest(`/api/files/${item.backendFileId}/view`, {
      headers: authHeaders(),
    });
    state.protectedViewerDocument = data;
    state.protectedViewerPage = 1;
    state.protectedViewerError = "";
    loadProtectedViewerPage();
  } catch (error) {
    state.protectedViewerError = errorMessage("uploads", "viewerFailed");
  } finally {
    state.protectedViewerLoading = false;
    render();
    requestAnimationFrame(() => document.querySelector(".protected-viewer-panel")?.focus());
  }
}

async function loadProtectedViewerPage() {
  const doc = state.protectedViewerDocument;
  if (!doc?.id || !state.session?.access_token) return;
  const pageCount = Math.max(1, Number(doc.pageCount || 1));
  const pageNumber = Math.min(Math.max(1, Number(state.protectedViewerPage || 1)), pageCount);
  state.protectedViewerPage = pageNumber;
  state.protectedViewerPageLoading = true;
  state.protectedViewerError = "";
  render();
  try {
    const blob = await apiBlobRequest(`/api/files/${doc.id}/pages/${pageNumber}`, {
      headers: authHeaders(),
    });
    clearProtectedPageImage();
    state.protectedViewerPageImageUrl = URL.createObjectURL(blob);
  } catch (error) {
    clearProtectedPageImage();
    state.protectedViewerError = errorMessage("uploads", "pageFailed");
  } finally {
    state.protectedViewerPageLoading = false;
    render();
  }
}

function helpWidget() {
  const locked = !state.user || state.route === "home";
  return `<aside class="help-widget ${state.helpOpen ? "open" : ""} ${locked ? "guest" : ""}" aria-label="Need help">
    ${state.helpOpen ? `<div class="help-layer" role="presentation">
      <button class="help-scrim" data-action="toggleHelp" aria-label="Close help widget"></button>
      <section class="help-panel" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="help-panel-head">
        <strong id="help-title">${locked ? "Account required" : "Need help?"}</strong>
        <button data-action="toggleHelp" aria-label="Close help widget">&times;</button>
      </div>
      ${locked
        ? `<div class="help-locked">
            <div class="help-lock-icon">${icons.shield}</div>
            <div class="help-lock-copy">
              <h3>Account required</h3>
              <p>You have to login or sign up first before contacting the archive administrator.</p>
            </div>
            <div class="help-lock-actions">
              <button class="help-primary" type="button" data-action="helpLogin">${icons.login}<span>Sign In</span></button>
              <button class="help-secondary" type="button" data-action="helpSignup">${icons.userPlus}<span>Sign Up</span></button>
            </div>
          </div>`
        : state.helpSent
        ? `<p class="help-success">Your message has been sent to the ARE archive administrator.</p>`
        : `<p>Contact the ARE archive administrator for account access, staff IDs, document uploads, or review support.</p>
          <form data-help-form autocomplete="off">
            <input name="supportDisplay" placeholder="Your name" value="" autocomplete="off" data-private-input readonly required />
            <input name="supportContact" type="text" inputmode="email" placeholder="Your email" value="" autocomplete="off" autocapitalize="none" spellcheck="false" data-private-input readonly required />
            <textarea name="supportBody" placeholder="What do you need help with?" autocomplete="off" data-private-input readonly required></textarea>
            <button class="auth-submit" type="submit">Contact Administrator</button>
          </form>`}
    </section>
    </div>` : ""}
    <button class="help-bubble" data-action="toggleHelp" aria-label="Need help, contact administrator">
      <span>?</span>
      <b>Need help</b>
    </button>
  </aside>`;
}

function dashboard() {
  // Dashboard content adapts by role while still using the same shell and quick access patterns.
  if (!state.user) {
    navigate("login");
    return "";
  }
  if (isPendingApproval()) {
    return shell(pendingApprovalScreen(), { dashboard: true });
  }

  if (["projects", "materials", "search"].includes(state.route)) {
    return shell(studentArchiveScreen(), { dashboard: true });
  }
  if (state.route === "saved") {
    return shell(savedLibraryScreen(), { dashboard: true });
  }
  if (state.route === "settings") {
    return shell(settingsScreen(), hasAdminAccess() ? { admin: true } : { dashboard: true });
  }
  if (state.route === "upload") {
    return shell(staffUploadScreen(), { dashboard: true });
  }
  if (state.route === "lecturer") {
    return shell(lecturerPanel(), { dashboard: true });
  }
  if (hasAdminAccess()) {
    return adminDashboard();
  }
  if (state.user.hod) {
    return shell(hodDashboard(), { dashboard: true });
  }
  if (roleSlug() === "staff") {
    return shell(staffDashboard(), { dashboard: true });
  }

  const savedProjects = savedResourceItems("project").length;
  const savedMaterials = savedResourceItems("material").length;
  const myProjects = roleSlug() === "student" ? savedProjects : appData.uploads.filter((item) => item.kind === "Project" && (item.status === "Approved" || item.uploader === currentName())).length;
  const myMaterials = roleSlug() === "student" ? savedMaterials : appData.uploads.filter((item) => item.kind === "Material" && (item.status === "Approved" || item.uploader === currentName())).length;
  const pendingReviews = appData.uploads.filter((item) => item.status === "Pending Review" && (item.uploader === currentName() || canManageStaff())).length;
  const isStaffDashboard = hasStaffWorkspaceAccess();
  return shell(`
    <main class="dashboard-page ${isStaffDashboard ? "staff-dashboard-page" : ""}">
      <section class="dashboard-hero${activeTourAnchor("hero")}" data-tour-anchor="hero">
        ${profileAvatar(currentName(), "dash-avatar")}
        <div>
          <h1>Welcome back, ${escapeHtml(currentName())}</h1>
          <p><span>${escapeHtml(state.user.role || "Student")}</span> ${DEPARTMENT_NAME}</p>
        </div>
        ${tourStartButton()}
      </section>

      <section class="dashboard-search${activeTourAnchor("search")}" data-tour-anchor="search">
        ${icons.search}
        <input name="dashboardSearch" data-dashboard-search placeholder="Search projects, materials, authors..." value="${escapeHtml(state.search)}" />
      </section>

      <section class="dashboard-stats${activeTourAnchor("stats")}" data-tour-anchor="stats">
        ${dashStat(myProjects, roleSlug() === "student" ? "Bookmarked Projects" : "Projects", icons.file)}
        ${dashStat(myMaterials, roleSlug() === "student" ? "Saved Materials" : "Materials", icons.book)}
        ${isStaffDashboard ? dashStat(pendingReviews, "Pending Review", icons.clock) : ""}
      </section>

      ${roleFunctionPanel()}

      <section class="quick-section${activeTourAnchor("quick")}" data-tour-anchor="quick">
        <h2>${icons.trending} Quick Access</h2>
        <div class="quick-grid">
          ${quickCard("Browse Projects", "Explore archived academic works", icons.archive, "projects")}
          ${quickCard("Course Materials", "Past questions, notes & slides", icons.book, "materials")}
          ${quickCard("Search Archive", "Find anything instantly", icons.search, "search")}
        </div>
      </section>

      <section class="resource-section" data-view="${state.route}">
        ${resourceContent()}
      </section>
    </main>
  `, { dashboard: true });
}

function pendingApprovalScreen() {
  const role = roleSlug();
  const reviewerText = role === "admin"
    ? "Your admin request is waiting for Super Admin verification."
    : "Your staff request is waiting for HOD and Super Admin verification.";
  return `
    <main class="pending-approval-page">
      <section class="pending-approval-card">
        <div class="student-icon purple pending-review-icon"><span class="pending-review-main-icon">${role === "admin" ? icons.shield : icons.userCircle}</span><i>${icons.clock}</i></div>
        <span>Verification Pending</span>
        <h1>${escapeHtml(displayRole())} access is under review</h1>
        <p>${escapeHtml(reviewerText)} You can sign out or check back after approval.</p>
        <dl>
          <div><dt>Email</dt><dd>${escapeHtml(state.user.email || state.email)}</dd></div>
          <div><dt>Staff/Admin ID</dt><dd class="masked-id">****</dd></div>
          <div><dt>Status</dt><dd class="pending-status-pill">Pending approval</dd></div>
        </dl>
        <button class="auth-submit" type="button" data-action="signOut">${icons.logout}<span>Sign Out</span></button>
      </section>
    </main>
  `;
}

const workCategories = [
  ["FYP", icons.cap],
  ["Research", icons.book],
  ["Proposals", icons.clipboard],
  ["Field Reports", icons.briefcase],
  ["Seminars", icons.mic],
];

const materialLevels = ["100L", "200L", "300L", "400L", "500L"];
const materialTypes = ["PDFs", "Past Questions", "Slides"];

function materialTypeGroup(item) {
  const type = String(item.type || item.fileName || "").toLowerCase();
  const fileName = String(item.fileName || "").toLowerCase();
  if (type.includes("past question")) return "Past Questions";
  if (type.includes("slide") || type.includes("presentation") || fileName.endsWith(".ppt") || fileName.endsWith(".pptx")) return "Slides";
  return "PDFs";
}

function materialTypeIcon(type) {
  if (type === "Past Questions") return icons.file;
  if (type === "Slides") return icons.grid;
  return icons.book;
}

function studentArchiveScreen() {
  if (state.route === "projects") return projectsScreen();
  if (state.route === "materials") return materialsScreen();
  return searchScreen();
}

function archiveProjects() {
  if (state.liveArchive.loaded) {
    return state.liveArchive.projects.map(enrichProjectRecord);
  }
  const approvedUploads = appData.uploads
    .filter((item) => item.kind === "Project" && item.status === "Approved")
    .map((item, index) => enrichProjectRecord({
      id: item.id,
      backendFileId: item.backendFileId,
      storagePath: item.storagePath,
      fileName: item.fileName,
      fileType: item.fileType,
      fileSize: item.fileSize,
      title: item.title,
      type: item.type || "Department Upload",
      category: item.category || "FYP",
      year: new Date(item.at).getFullYear().toString(),
      meta: item.department || DEPARTMENT_NAME,
      abstract: item.abstract || "",
    }, index));
  return [...approvedUploads, ...projects.map(enrichProjectRecord)];
}

function archiveMaterials() {
  if (state.liveArchive.loaded) {
    return state.liveArchive.materials;
  }
  const approvedUploads = appData.uploads
    .filter((item) => item.kind === "Material" && item.status === "Approved")
    .map((item) => ({ code: item.courseCode || "ARE", title: item.title, type: item.type || item.materialType || item.fileName || "PDF", fileName: item.fileName, level: item.level || "400L" }));
  return [...approvedUploads, ...materials];
}

function enrichProjectRecord(item, index = 0) {
  const category = item.category || "FYP";
  const protectedWork = ["FYP", "Proposals"].includes(category);
  return {
    ...item,
    category,
    bookId: item.bookId || `ARE-${item.year || "2026"}-${String(index + 1).padStart(3, "0")}`,
    cabinet: item.cabinet || `Cabinet ${String.fromCharCode(65 + (index % 3))}`,
    row: item.row || `Row ${Math.floor(index / 3) + 1}`,
    column: item.column || `Column ${(index % 4) + 1}`,
    protectedWork,
  };
}

function archiveCards(items, viewMode = state.viewMode) {
  return `<div class="resource-grid archive-results ${escapeHtml(viewMode)}">${items.map((item) => {
    const saved = isResourceSaved(item);
    const kind = resourceKind(item);
    const protectedWork = item.protectedWork || (kind === "project" && ["FYP", "Proposals"].includes(item.category));
    const canOpenMaterial = kind === "material" && item.backendFileId;
    const label = item.type || item.code;
    const chipClass = kind === "material" ? ` material-${materialTypeSlug(materialTypeGroup(item))}` : "";
    if (kind === "material") {
      const typeLabel = materialShortLabel(materialTypeGroup(item));
      return `<article class="${saved ? "saved" : ""} material-card">
        <div class="resource-topline">
          <span class="resource-chip${chipClass}">${escapeHtml(typeLabel)}</span>
        </div>
        <div class="material-card-body">
          <div>
            <span>Course Code</span>
            <strong>${escapeHtml(item.code || "ARE")}</strong>
          </div>
          <div>
            <span>Title</span>
            <h3>${escapeHtml(item.title)}</h3>
          </div>
        </div>
        <button class="save-resource ${saved ? "active" : ""}" type="button" data-action="toggleSaveResource" data-resource-id="${escapeHtml(resourceId(item))}" aria-pressed="${saved ? "true" : "false"}" aria-label="${saved ? "Remove from saved resources" : "Save material"}">
          <span class="save-icon">${saved ? icons.check : icons.bookmark}</span><span class="save-label">${saved ? "Saved" : "Save"}</span>
        </button>
        ${canOpenMaterial ? `<div class="resource-actions material-actions"><button type="button" data-action="viewProtectedWork" data-resource-id="${escapeHtml(resourceId(item))}">${icons.eye}<span>View</span></button></div>` : ""}
      </article>`;
    }
    return `<article class="${saved ? "saved" : ""} ${protectedWork ? "protected-work" : ""} ${kind === "material" ? "material-card" : "project-card"}">
      <div class="resource-topline">
        <span class="resource-chip${chipClass}">${escapeHtml(label)}</span>
        <small>${escapeHtml(item.year || item.level || "Material")}</small>
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.meta || item.type || item.code)}</p>
      ${kind === "project" ? `<dl class="resource-location">
        <div><dt>Book ID</dt><dd>${escapeHtml(item.bookId || "ARE-000")}</dd></div>
        <div><dt>Cabinet</dt><dd>${escapeHtml(item.cabinet || "Cabinet A")}</dd></div>
        <div><dt>Row</dt><dd>${escapeHtml(item.row || "Row 1")}</dd></div>
        <div><dt>Column</dt><dd>${escapeHtml(item.column || "Column 1")}</dd></div>
      </dl>` : ""}
      ${protectedWork ? `<div class="resource-actions"><button type="button" data-action="viewProtectedWork" data-resource-id="${escapeHtml(resourceId(item))}">${icons.eye}<span>View</span></button><button type="button" data-action="downloadAbstract" data-resource-id="${escapeHtml(resourceId(item))}">${icons.download}<span>Abstract</span></button></div>` : ""}
      <button class="save-resource ${saved ? "active" : ""}" type="button" data-action="toggleSaveResource" data-resource-id="${escapeHtml(resourceId(item))}" aria-pressed="${saved ? "true" : "false"}" aria-label="${saved ? "Remove from saved resources" : `Save ${kind}`}">
        <span class="save-icon">${saved ? icons.check : icons.bookmark}</span><span class="save-label">${saved ? "Saved" : "Save"}</span>
      </button>
    </article>`;
  }).join("")}</div>`;
}

function materialTypeSlug(type = "") {
  return String(type).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function materialCourseTitle(item) {
  return String(item.courseTitle || item.course || item.title || "Course")
    .replace(/\s+(slides?|past questions?|lecture notes?|notes|formula sheet|pdf)$/i, "")
    .trim();
}

function materialShortLabel(type = "") {
  if (type === "Past Questions") return "PQ";
  if (type === "Slides") return "Slides";
  return "PDF";
}

function savedLibraryScreen() {
  const savedProjects = savedResourceItems("project");
  const savedMaterials = savedResourceItems("material");
  const allSaved = [...savedProjects, ...savedMaterials];
  return `
    <main class="student-page saved-page">
      <section class="student-center-hero">
        <div class="student-icon purple">${icons.library}</div>
        <h1>Saved Library</h1>
        <p>Everything you bookmarked for later, grouped in one quiet place.</p>
      </section>
      ${liveArchiveNotice()}
      <section class="saved-summary">
        ${dashStat(savedProjects.length, "Bookmarked Projects", icons.file)}
        ${dashStat(savedMaterials.length, "Saved Materials", icons.book)}
        ${dashStat(allSaved.length, "Total Saved", icons.bookmark)}
      </section>
      ${allSaved.length ? `
        <section class="saved-section">
          <div class="section-heading compact"><h2>Saved Resources</h2><p>Remove any item with the Saved button when you no longer need it.</p></div>
          ${archiveCards(allSaved, "grid")}
        </section>
      ` : polishedEmpty("No saved resources yet", "Bookmark projects or materials and they will appear here.", icons.library, "Browse Projects", "projects")}
    </main>
  `;
}

function settingsScreen() {
  const roleDetails = roleSlug() === "staff"
    ? [["Staff ID", state.user.staffId || "Not set"], ["Title", state.user.title || "Lecturer"], ["Department", state.user.department || DEPARTMENT_NAME]]
    : [["Matric Number", state.user?.matricNumber || "Not set"], ["Level", state.user?.level || "Not set"], ["Department", state.user?.department || DEPARTMENT_NAME]];
  return `
    <main class="student-page settings-page ${isSuperAdmin() ? "super-admin-page super-settings-page" : ""}">
      <section class="settings-hero">
        ${profileAvatar(currentName(), "settings-avatar")}
        <div>
          <h1>Profile & Account</h1>
          <p>Manage your identity, role details, password, and notification preferences.</p>
        </div>
      </section>
      <section class="settings-grid">
        <article class="settings-card">
          <h2>${icons.users} Profile</h2>
          <label>Name<input name="profileDisplayName" value="${escapeHtml(currentName())}" readonly /></label>
          <label>Email<input name="profileEmail" value="${escapeHtml(state.user?.email || "")}" readonly /></label>
          <button class="auth-submit" type="button" data-action="changeProfile">${icons.upload}<span>Update Photo</span></button>
        </article>
        <article class="settings-card">
          <h2>${icons.shield} ${roleSlug() === "staff" ? "Staff Details" : "Student Details"}</h2>
          ${roleDetails.map(([label, value]) => `<label>${escapeHtml(label)}<input name="profile${label.replace(/[^a-z0-9]/gi, "")}" value="${escapeHtml(value)}" readonly /></label>`).join("")}
          <p class="settings-note">Role updates should be verified by the archive administrator before they affect access.</p>
        </article>
        <article class="settings-card">
          <h2>${icons.bell} Notifications</h2>
          <label class="settings-check"><input type="checkbox" name="notifyUploadStatus" checked disabled /> Upload status updates</label>
          <label class="settings-check"><input type="checkbox" name="notifyAdminReplies" checked disabled /> Admin replies</label>
          <label class="settings-check"><input type="checkbox" name="notifyApprovedMaterials" checked disabled /> New approved materials</label>
        </article>
        <article class="settings-card">
          <h2>${icons.settings} Password</h2>
          <p>Use password reset to update your password securely.</p>
          <button class="auth-submit" type="button" data-action="forgot">${icons.shield}<span>Reset Password</span></button>
        </article>
      </section>
    </main>
    ${resetPasswordModal()}
  `;
}

function polishedEmpty(title, body, icon, actionLabel = "", route = "") {
  return `<section class="polished-empty">
    <span>${icon}</span>
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(body)}</p>
    ${actionLabel ? `<button class="auth-submit" data-route="${escapeHtml(route)}">${escapeHtml(actionLabel)}</button>` : ""}
  </section>`;
}

function liveArchiveNotice() {
  return "";
}

function projectsScreen() {
  const query = state.search.trim().toLowerCase();
  const items = archiveProjects()
    .filter((item) => item.category === state.workCategory)
    .filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query))
    .sort((a, b) => {
      const first = Number(a.year || 0);
      const second = Number(b.year || 0);
      return state.projectSort === "oldest" ? first - second : second - first;
    });
  return `
    <main class="student-page project-page">
      <section class="student-center-hero">
        <div class="student-icon purple">${icons.file}</div>
        <h1>Academic Works Archive</h1>
        <p>Browse works by category</p>
      </section>
      ${liveArchiveNotice()}
      <section class="category-tabs">
        ${workCategories.map(([label, icon]) => `<button class="${state.workCategory === label ? "active" : ""}" data-work-category="${escapeHtml(label)}">${icon}<span>${escapeHtml(label)}</span></button>`).join("")}
      </section>
      <section class="student-toolbar project-toolbar">
        ${neonSearch("Search final year projects...", "project")}
        <button class="sort-button" data-action="toggleProjectSort">${icons.sort}<span>Year (${state.projectSort === "oldest" ? "Oldest" : "Newest"})</span>${icons.chevronDown}</button>
        <div class="view-toggle">
          ${viewButton("grid", icons.grid)}
          ${viewButton("list", icons.list)}
          ${viewButton("rows", icons.rows)}
        </div>
      </section>
      <p class="result-count">${items.length} results</p>
      ${items.length ? archiveCards(items) : emptyState(icons.file, `No ${workCategoryLabel(state.workCategory)} found`)}
    </main>
  `;
}

function materialsScreen() {
  // Flow: material type -> level -> course code. Documents stay hidden until every choice is clear.
  const query = state.search.trim().toLowerCase();
  const hasType = Boolean(state.materialType);
  const hasLevel = Boolean(state.materialLevel);
  const typedMaterials = hasType ? archiveMaterials().filter((item) => materialTypeGroup(item) === state.materialType) : [];
  const levelMaterials = hasType && hasLevel ? typedMaterials.filter((item) => item.level === state.materialLevel) : [];
  const courseCodes = [...new Set(levelMaterials.map((item) => item.code).filter(Boolean))];
  const selectedCourse = state.materialCourseCode && courseCodes.includes(state.materialCourseCode) ? state.materialCourseCode : "";
  const hasCourseCode = Boolean(selectedCourse);
  const items = hasType && hasLevel && hasCourseCode
    ? levelMaterials
      .filter((item) => item.code === selectedCourse)
      .filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query))
    : [];
  return `
    <main class="student-page materials-page">
      <section class="materials-heading">
        <div class="student-icon amber">${icons.book}</div>
        <div>
          <h1>Academic Materials</h1>
          <p>Course resources organized for quick access.</p>
        </div>
      </section>
      ${liveArchiveNotice()}
      <section class="student-toolbar material-toolbar">
        ${neonSearch("Search by title or course code...", "material")}
      </section>
      <section class="level-tabs material-type-tabs ${hasType ? "selected-material-tabs" : ""}" data-material-stage="types">
        ${hasType
          ? `<button class="active selected-level" type="button" aria-label="Selected material type">${materialTypeIcon(state.materialType)}<span>${escapeHtml(state.materialType)}</span></button><button class="change-level" type="button" data-action="changeMaterialType">${icons.chevronDown}<span>Change type</span></button>`
          : materialTypes.map((type) => `<button class="${state.materialType === type ? "active" : ""}" data-material-type="${escapeHtml(type)}">${materialTypeIcon(type)}<span>${escapeHtml(type)}</span></button>`).join("")}
      </section>
      ${hasType ? `
        <section class="level-tabs ${hasLevel ? "selected-level-tabs" : ""}" data-material-stage="levels">
          ${hasLevel
            ? `<button class="active selected-level" type="button" aria-label="Selected level">${icons.cap}<span>${state.materialLevel}</span></button><button class="change-level" type="button" data-action="changeMaterialLevel">${icons.chevronDown}<span>Change level</span></button>`
            : materialLevels.map((level) => `<button class="${state.materialLevel === level ? "active" : ""}" data-material-level="${level}">${icons.cap}<span>${level}</span></button>`).join("")}
        </section>
      ` : polishedEmpty("Choose material type", "Pick PDFs, slides, or past questions first.", icons.book)}
      ${hasLevel && hasType ? `
        <section class="level-tabs course-code-tabs" data-material-stage="codes">
          ${courseCodes.length ? courseCodes.map((code) => `<button class="${selectedCourse === code ? "active" : ""}" data-material-code="${escapeHtml(code)}">${icons.clipboard}<span>${escapeHtml(code)}</span></button>`).join("") : ""}
        </section>
      ` : ""}
      ${hasLevel && hasType ? `
        <p class="material-count" data-material-stage="results">${icons.spark} <span>${escapeHtml(state.materialType)} &middot; ${state.materialLevel}${selectedCourse ? ` &middot; ${escapeHtml(selectedCourse)}` : ""} &middot; ${items.length} materials</span></p>
        ${hasCourseCode ? (items.length ? archiveCards(items) : emptyState(icons.book, `No ${state.materialType.toLowerCase()} found for ${selectedCourse}`)) : polishedEmpty("Choose course code", "Select a course code to reveal matching materials.", icons.book)}
      ` : ""}
    </main>
  `;
}

function scrollMaterialStage(stage) {
  window.setTimeout(() => {
    document.querySelector(`[data-material-stage="${stage}"]`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, 80);
}

function searchScreen() {
  const query = state.search.trim().toLowerCase();
  const allItems = [...archiveProjects(), ...archiveMaterials()];
  const typeFiltered = state.contentType === "Projects"
    ? archiveProjects()
    : state.contentType === "Materials"
      ? archiveMaterials()
      : allItems;
  const results = (query ? typeFiltered.filter((item) => JSON.stringify(item).toLowerCase().includes(query)) : typeFiltered)
    .filter((item) => state.searchYear === "All Years" || item.year === state.searchYear)
    .filter((item) => state.searchLevel === "All Levels" || item.level === state.searchLevel)
    .filter((item) => state.searchMaterialType === "All Types" || item.type === state.searchMaterialType || item.category === state.searchMaterialType);
  return `
    <main class="student-page search-page">
      <section class="student-center-hero">
        <div class="student-icon purple">${icons.search}</div>
        <h1>Search Archive</h1>
        <p>Find projects, materials, and resources</p>
      </section>
      ${liveArchiveNotice()}
      <section class="student-toolbar search-wide">
        ${neonSearch("Search everything...", "archive", `<button class="type-filter" data-type-filter>${icons.filter}<span>${escapeHtml(state.contentType)}</span>${icons.chevronDown}</button>`)}
      </section>
      <section class="search-filters">
        ${filterButton("year", state.searchYear, ["All Years", ...new Set(archiveProjects().map((item) => item.year).filter(Boolean))])}
        ${filterButton("level", state.searchLevel, ["All Levels", ...materialLevels])}
        ${filterButton("materialType", state.searchMaterialType, ["All Types", ...new Set(allItems.map((item) => item.type || item.category).filter(Boolean))])}
      </section>
      <p class="result-count">${results.length} results</p>
      ${results.length ? archiveCards(results, "grid") : polishedEmpty("No results found", "Try a broader keyword, year, level, type, author, supervisor, or category.", icons.search)}
    </main>
  `;
}

function filterButton(kind, value, options) {
  return `<button class="filter-pill" data-search-filter="${escapeHtml(kind)}" data-options="${escapeHtml(options.join("|"))}">
    ${icons.filter}<span>${escapeHtml(value)}</span>${icons.chevronDown}
  </button>`;
}

function neonSearch(placeholder, context, rightControl = "") {
  return `<label class="neon-search" data-search-context="${context}">${icons.search}<input name="${context}Search" data-student-search placeholder="${placeholder}" value="${escapeHtml(state.search)}" />${rightControl}</label>`;
}

function staffDashboard() {
  const staffUploads = staffWorkspaceUploads(false);
  const approved = staffUploads.filter((item) => item.status === "Approved").length;
  const pending = staffUploads.filter((item) => item.status === "Pending Review").length;
  const rejected = staffUploads.filter((item) => item.status === "Rejected").length;
  const drafts = staffUploads.filter((item) => item.status === "Draft" || item.status === "Submitted").length;
  return `
    <main class="staff-page role-dashboard staff-dashboard lecturer-shell" data-panel-shell="lecturer">
      <section class="role-hero${activeTourAnchor("hero")}" data-tour-anchor="hero">
        <div class="student-icon purple">${icons.staff}</div>
        <div>
          <h1>Lecturer Dashboard</h1>
          <p>Upload projects and materials, then follow every submission through review.</p>
        </div>
        ${tourStartButton()}
      </section>

      <section class="role-stats${activeTourAnchor("stats")}" data-tour-anchor="stats">
        ${dashStat(staffUploads.length, "My Uploads", icons.upload)}
        ${dashStat(approved, "Approved", icons.check)}
        ${dashStat(pending, "Pending Review", icons.clock)}
        ${dashStat(rejected + drafts, "Needs Attention", icons.shield)}
      </section>

      <section class="review-workflow${activeTourAnchor("stats")}">
        ${reviewStep("Draft", "Prepare metadata", icons.file, staffUploads.some((item) => item.status === "Draft"))}
        ${reviewStep("Submitted", "File received", icons.upload, staffUploads.some((item) => item.status === "Submitted"))}
        ${reviewStep("Pending Review", "Awaiting HOD/Admin", icons.clock, pending > 0)}
        ${reviewStep("Approved", "Visible to students", icons.check, approved > 0)}
        ${reviewStep("Rejected", "Needs correction", icons.alert, rejected > 0)}
      </section>

      <section class="role-actions${activeTourAnchor("quick")}" data-tour-anchor="quick">
        <button class="quick-card" data-action="openProjectUpload"><span>${icons.file}</span><strong>Upload Project</strong><p>Send a project to the archive review queue</p></button>
        <button class="quick-card" data-action="openMaterialUpload"><span>${icons.book}</span><strong>Upload Material</strong><p>Add notes, past questions, slides, or guides</p></button>
        ${quickCard("Lecturer Workspace", "View submissions and departmental activity", icons.staff, "lecturer")}
      </section>

      <section class="role-grid">
        <article class="lecturer-card">
          <h2>${icons.upload} Recent Submissions</h2>
          ${staffWorkspaceStatus()}
          ${staffUploads.length ? staffUploads.slice(0, 6).map(uploadRow).join("") : polishedEmpty("No uploads yet", "Start with Upload Project or Upload Material to create your first review item.", icons.upload)}
        </article>
        <article class="lecturer-card">
          <h2>${icons.search} Staff Shortcuts</h2>
          <div class="role-shortcuts">
            <button data-route="projects">${icons.archive}<span>Browse Projects</span></button>
            <button data-route="materials">${icons.book}<span>Course Materials</span></button>
            <button data-route="search">${icons.search}<span>Search Archive</span></button>
          </div>
        </article>
      </section>
    </main>
  `;
}

function hodDashboard() {
  const staffUsers = staffRoster();
  const pendingStaff = staffUsers.filter((user) => isPendingStatus(user.status)).length;
  const departmentUploads = staffWorkspaceUploads(true);
  const pendingReviews = departmentUploads.filter((item) => item.status === "Pending Review").length;
  return `
    <main class="staff-page role-dashboard hod-dashboard lecturer-shell" data-panel-shell="lecturer">
      <section class="role-hero hod${activeTourAnchor("hero")}" data-tour-anchor="hero">
        <div class="student-icon purple">${icons.shield}</div>
        <div>
          <h1>HOD Dashboard</h1>
          <p>Review departmental submissions, verify lecturer access, and keep archive approvals traceable.</p>
        </div>
        ${tourStartButton()}
      </section>

      <section class="role-stats${activeTourAnchor("stats")}" data-tour-anchor="stats">
        ${dashStat(departmentUploads.length, "Department Uploads", icons.upload)}
        ${dashStat(pendingReviews, "Pending Reviews", icons.clock)}
        ${dashStat(staffUsers.length, "Staff Members", icons.users)}
        ${dashStat(pendingStaff, "Staff Requests", icons.userPlus)}
      </section>

      <section class="role-actions${activeTourAnchor("quick")}" data-tour-anchor="quick">
        <button class="quick-card" data-route="lecturer"><span>${icons.shield}</span><strong>HOD Panel</strong><p>Open staff controls and submission lists</p></button>
        <button class="quick-card" data-staff-action="approve-next"><span>${icons.check}</span><strong>Approve Next Staff</strong><p>Approve the next pending staff request</p></button>
        <button class="quick-card" data-route="upload"><span>${icons.upload}</span><strong>Upload Resource</strong><p>Add a reviewed department resource</p></button>
      </section>

      <section class="role-grid">
        <article class="lecturer-card">
          <h2>${icons.users} Staff Access</h2>
          ${staffWorkspaceStatus()}
          ${staffUsers.length ? staffUsers.slice(0, 6).map(staffRow).join("") : polishedEmpty("No staff requests", "New staff accounts awaiting approval will appear here.", icons.users)}
        </article>
        <article class="lecturer-card">
          <h2>${icons.clock} Department Review Queue</h2>
          ${departmentUploads.length ? departmentUploads.slice(0, 6).map(uploadRow).join("") : polishedEmpty("No departmental uploads", "Lecturer submissions will appear here after upload.", icons.clock)}
        </article>
      </section>
    </main>
  `;
}

function viewButton(view, icon) {
  return `<button class="${state.viewMode === view ? "active" : ""}" data-view-mode="${view}" aria-label="${view} view">${icon}</button>`;
}

function workCategoryLabel(category) {
  if (category === "FYP") return "final year projects";
  if (category === "Research") return "research projects";
  if (category === "Proposals") return "proposals";
  if (category === "Field Reports") return "field reports";
  return `${category.toLowerCase()} projects`;
}

function emptyState(icon, label) {
  return `<section class="student-empty">${icon}<p>${escapeHtml(label)}</p></section>`;
}

function staffUploadScreen() {
  return `
    <main class="staff-page upload-page lecturer-shell" data-panel-shell="lecturer">
      <section class="student-center-hero staff-upload-hero">
        <div class="student-icon purple">${icons.upload}</div>
        <h1>Upload Resource</h1>
        <p>Select what you want to upload, then add the required archive details.</p>
      </section>
      <section class="upload-tabs">
        <button class="${state.uploadMode === "project" ? "active" : ""}" data-upload-mode="project" data-upload-material-type="">${icons.file}<span>Project</span></button>
        <button class="${state.uploadMode === "material" && state.uploadMaterialType === "PDF" ? "active" : ""}" data-upload-mode="material" data-upload-material-type="PDF">${icons.file}<span>PDF</span></button>
        <button class="${state.uploadMode === "material" && state.uploadMaterialType === "Past Question" ? "active" : ""}" data-upload-mode="material" data-upload-material-type="Past Question">${icons.clipboard}<span>Past Question</span></button>
        <button class="${state.uploadMode === "material" && state.uploadMaterialType === "Slides" ? "active" : ""}" data-upload-mode="material" data-upload-material-type="Slides">${icons.book}<span>Slides</span></button>
      </section>
      ${state.uploadNotice ? `<p class="upload-notice">${escapeHtml(state.uploadNotice)}</p>` : ""}
      ${state.uploadMode === "project" ? projectUploadForm() : materialUploadForm()}
    </main>
  `;
}

function projectUploadForm() {
  return `<form class="staff-upload-card" data-staff-upload="Project">
    <label>Project Title<input name="title" placeholder="Enter project title" required /></label>
    <label>Abstract<textarea name="abstract" placeholder="Paste the project abstract"></textarea></label>
    <div class="form-grid two">
      <label>Project ID<input name="projectId" placeholder="e.g. ARE/2025/001" /></label>
      <label>Year<input name="year" placeholder="e.g. 2024" /></label>
      <label>Supervisor<input name="supervisor" placeholder="e.g. Dr. Akinola" /></label>
      <label>Physical Location<input name="location" placeholder="e.g. Cabinet A3, Shelf 2" /></label>
    </div>
    <label>Keywords<input name="keywords" placeholder="Comma-separated keywords" /></label>
    <label>Authors<input name="authors" placeholder="Comma-separated author names" /></label>
    ${dropZone("PDF, DOC, PPTX up to 50MB")}
    <button class="auth-submit" type="submit" ${state.uploadSubmitting ? "disabled" : ""}>${icons.upload}<span>${state.uploadSubmitting ? "Uploading..." : "Upload Project"}</span></button>
  </form>`;
}

function materialUploadForm() {
  return `<form class="staff-upload-card" data-staff-upload="Material">
    <input type="hidden" name="materialType" value="${escapeHtml(state.uploadMaterialType || "PDF")}" />
    <div class="form-grid two">
      <label>Course Code<input name="courseCode" placeholder="e.g. ARE 301" required /></label>
      <label>Course Title<input name="courseTitle" placeholder="e.g. Farm Management" required /></label>
    </div>
    <div class="form-grid three">
      <label>Level<select name="level" required><option value="">Select level</option><option>100L</option><option>200L</option><option>300L</option><option>400L</option><option>500L</option></select></label>
      <label>Semester<select name="semester" required><option value="">Select semester</option><option>First Semester</option><option>Second Semester</option></select></label>
      <label>Type<input name="materialTypeLabel" value="${escapeHtml(state.uploadMaterialType || "PDF")}" readonly /></label>
    </div>
    <label>Title<input name="title" placeholder="e.g. 2023/2024 First Semester Exam" required /></label>
    ${dropZone("PDF, DOC, PPTX up to 50MB")}
    <button class="auth-submit" type="submit" ${state.uploadSubmitting ? "disabled" : ""}>${icons.upload}<span>${state.uploadSubmitting ? "Uploading..." : "Upload Material"}</span></button>
  </form>`;
}

function dropZone(note) {
  const file = state.uploadFile;
  return `<label class="drop-zone ${file ? "has-file" : ""} ${state.uploadError ? "has-error" : ""}" data-drop-zone>
    <input type="file" name="resourceFile" accept=".pdf,.doc,.docx,.ppt,.pptx" data-upload-file />
    ${icons.upload}
    <strong>${file ? escapeHtml(file.name) : "Click to upload or drag and drop"}</strong>
    <span>${file ? `${escapeHtml(formatFileSize(file.size))} &middot; ${escapeHtml(fileExtension(file.name).toUpperCase())}` : note}</span>
    ${state.uploadError ? `<em>${escapeHtml(state.uploadError)}</em>` : ""}
  </label>`;
}

function lecturerPanel() {
  const staffUsers = staffRoster();
  const staffUploads = staffWorkspaceUploads(canManageStaff());
  const pending = staffUploads.filter((item) => item.status === "Pending Review").length;
  const approved = staffUploads.filter((item) => item.status === "Approved").length;
  const rejected = staffUploads.filter((item) => item.status === "Rejected").length;
  return `
    <main class="staff-page lecturer-page lecturer-workspace lecturer-shell" data-panel-shell="lecturer">
      <section class="lecturer-hero">
        <div class="student-icon purple">${icons.staff}</div>
        <div>
          <h1>${canManageStaff() ? "Department Review Panel" : "Lecturer Workspace"}</h1>
          <p>${canManageStaff() ? "Manage lecturer access and review department submissions." : "Track your uploads, corrections, and approved archive records."}</p>
        </div>
      </section>
      <section class="lecturer-stats">
        ${dashStat(staffUploads.length, canManageStaff() ? "Department Uploads" : "My Uploads", icons.upload)}
        ${dashStat(pending, "Pending Reviews", icons.clock)}
        ${dashStat(approved, "Approved", icons.check)}
        ${dashStat(canManageStaff() ? staffUsers.length : rejected, canManageStaff() ? "Department Staff" : "Needs Correction", canManageStaff() ? icons.users : icons.alert)}
      </section>
      <section class="lecturer-toolbar">
        <button data-route="upload">${icons.upload}<span>Upload Resource</span></button>
        <button data-action="openProjectUpload">${icons.file}<span>New Project</span></button>
        <button data-action="openMaterialUpload">${icons.book}<span>New Material</span></button>
      </section>
      <section class="lecturer-grid">
        <article class="lecturer-card">
          <h2>${icons.upload} Recent Submissions</h2>
          ${staffWorkspaceStatus()}
          ${staffUploads.length ? staffUploads.slice(0, 8).map(uploadRow).join("") : polishedEmpty("No submissions yet", "Uploads from this workspace will appear here after the backend receives them.", icons.upload)}
        </article>
        <article class="lecturer-card hod-card ${canManageStaff() ? "" : "locked"}">
          <h2>${icons.shield} ${canManageStaff() ? "Staff Access Control" : "Review Access"}</h2>
          ${canManageStaff() ? hodControls(staffUsers) : polishedEmpty("HOD access required", "Only HOD and Super Admin accounts can approve or suspend lecturer access.", icons.lock)}
        </article>
      </section>
    </main>
  `;
}

function staffRoster() {
  const remoteRoster = state.liveStaff.loaded ? state.liveStaff.staff : [];
  const roster = remoteRoster.length ? remoteRoster : appData.users.filter((user) => user.role === "Staff");
  if (hasStaffWorkspaceAccess() && !roster.some((user) => user.email === state.user.email)) {
    roster.unshift({ id: "current-staff", name: currentName(), email: state.user.email, role: "Staff", status: state.user.hod ? "HOD" : "Active", department: state.user.department || DEPARTMENT_NAME });
  }
  return roster;
}

function staffWorkspaceUploads(includeDepartment = false) {
  if (state.liveAdmin.loaded && hasAdminAccess()) {
    return includeDepartment ? state.liveAdmin.uploads : state.liveAdmin.uploads.filter((item) => item.uploaderId === state.user?.id || item.uploader === currentName() || item.uploaderEmail === state.user?.email);
  }
  if (state.liveStaff.loaded) {
    return includeDepartment ? state.liveStaff.uploads : state.liveStaff.uploads.filter((item) => item.uploaderId === state.user?.id || item.uploader === currentName() || item.uploaderEmail === state.user?.email);
  }
  return appData.uploads.filter((item) => includeDepartment || item.uploader === currentName());
}

function staffWorkspaceStatus() {
  if (state.liveStaff.loading) return `<p class="soft-empty">Loading live workspace...</p>`;
  if (state.liveStaff.error) return `<p class="soft-empty error">${escapeHtml(state.liveStaff.error)}</p>`;
  return "";
}

async function reviewUpload({ resourceId, resourceType, decision, comment = "" }) {
  try {
    await apiRequest("/api/reviews/uploads", {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ resourceId, resourceType, decision, comment }),
    });
    showStatusToast(decision === "approved" ? "Upload approved." : "Upload rejected.", "Review", decision === "approved");
    state.liveArchive.loaded = false;
    await loadStaffWorkspace({ force: true });
    await loadStudentArchive({ force: true });
  } catch (error) {
    showStatusToast(error?.message || errorMessage("uploads", "failed"), "Review", false);
  }
}

function isPendingStatus(status = "") {
  return String(status).toLowerCase() === "pending";
}

function uploadRow(item) {
  const status = item.status || "Pending Review";
  const canReview = canManageStaff() && statusSlug(status) === "pending-review";
  const resourceType = item.kind === "Material" ? "material" : "project";
  return `<div class="upload-row status-${statusSlug(status)}">
    <span>${item.kind === "Material" ? icons.book : icons.file}</span>
    <div>
      <strong>${escapeHtml(item.title)}</strong>
      <small>${escapeHtml(item.kind || "Upload")} &middot; ${statusPill(status)} ${item.uploader && canManageStaff() ? `&middot; ${escapeHtml(item.uploader)}` : ""}</small>
      ${item.reviewComment ? `<em>${escapeHtml(item.reviewComment)}</em>` : ""}
    </div>
    ${canReview ? `<div class="upload-row-actions">
      <button data-staff-action="approve-upload" data-review-id="${escapeHtml(item.id)}" data-review-type="${resourceType}">${icons.check}<span>Approve</span></button>
      <button data-staff-action="reject-upload" data-review-id="${escapeHtml(item.id)}" data-review-type="${resourceType}">${icons.alert}<span>Reject</span></button>
    </div>` : ""}
  </div>`;
}

function reviewStep(label, desc, icon, active = false) {
  return `<article class="${active ? "active" : ""}">${icon}<strong>${escapeHtml(label)}</strong><span>${escapeHtml(desc)}</span></article>`;
}

function statusSlug(status = "Pending Review") {
  return String(status).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function statusLabel(status = "Pending Review") {
  return String(status || "Pending Review")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function statusPill(status = "Pending Review") {
  return `<b class="status-pill status-${statusSlug(status)}">${escapeHtml(statusLabel(status))}</b>`;
}

function hodControls(staffUsers) {
  return `<div class="hod-actions">
    <button data-staff-action="approve-next">${icons.shield}<span>Approve Next</span></button>
    <button data-route="upload">${icons.upload}<span>Upload Resource</span></button>
  </div>
  <div class="staff-list">
    ${staffUsers.length ? staffUsers.map(staffRow).join("") : polishedEmpty("No staff members yet", "Staff signup requests will show here after role setup.", icons.users)}
  </div>`;
}

function staffRow(user) {
  const status = user.status || "Active";
  const pending = isPendingStatus(status);
  return `<article class="staff-row">
    <span>${initials(user.name)}</span>
    <div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)} &middot; ${statusPill(status)}${user.staffId ? ` &middot; ${escapeHtml(user.staffId)}` : ""}</small></div>
    ${user.id === "current-staff" ? "" : `<button data-staff-action="${pending ? "approve-staff" : "toggle-staff"}" data-staff-id="${escapeHtml(user.id)}">${pending ? "Approve" : status === "suspended" || status === "Suspended" ? "Restore" : "Suspend"}</button>`}
  </article>`;
}

function adminLogin() {
  return shell(`
    <main class="admin-login-page">
      <section class="admin-login-panel">
        <span class="root-pill">${icons.terminal} ROOT</span>
        <h1>Super Admin Access</h1>
        <p>Sign in with an approved admin or super admin account to enter this control center.</p>
        <button class="auth-submit" data-route="login">${icons.login}<span>Go to Login</span></button>
      </section>
    </main>
  `);
}

function rootLogin() {
  const rootEmail = String(state.rootEmail || "").trim().toLowerCase();
  const rootStep = state.rootAuthStep === "secret" ? "secret" : "password";
  const rootMotion = state.rootStepMotion ? ` root-step-${state.rootStepMotion}` : "";
  const rootBusy = state.authSubmitting === "login" || state.authSubmitting === "root-reset-link";
  const rootAccessBody = rootStep === "secret"
    ? "Second gate required. Enter the private root phrase."
    : "Private terminal entry for the configured root owner only.";
  return shell(`
    <main class="root-login-page ${rootBusy ? "root-busy" : ""}">
      <section class="root-grid-scene" aria-label="Super Admin root login">
        <div class="root-login-panel">
          <div class="root-corners" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <div class="root-login-content${rootMotion}">
            <div class="root-terminal-label">&gt; SYSTEM_AUTH_PROTOCOL</div>
            <h2>${rootStep === "secret" ? "Secret Phrase" : "Authenticate"}</h2>
            <p class="root-subtitle">${escapeHtml(rootAccessBody)}</p>
            <form class="root-login-form root-stage root-stage-${rootStep}" data-auth-form data-root-step="${rootStep}">
              ${rootStep === "secret" ? `
                <label class="root-input-group">
                  <span>Super Admin Email</span>
                  <input name="username" type="email" value="${escapeHtml(rootEmail)}" autocomplete="username" required />
                </label>
                <label class="root-input-group">
                  <span>Secret phrase</span>
                  <input name="rootSecretPhrase" type="${state.showPassword ? "text" : "password"}" placeholder="Enter secret phrase" autocomplete="off" data-private-input readonly required />
                </label>
                <div class="root-links">
                  <button type="button" data-action="backRootPassword">Back to password</button>
                  <strong>Gate 2 of 2</strong>
                </div>
              ` : `
                <label class="root-input-group">
                  <span>Super Admin Email</span>
                  <input name="username" type="email" value="${escapeHtml(rootEmail)}" placeholder="Enter root email" autocomplete="username" autocapitalize="none" spellcheck="false" required />
                </label>
                <label class="root-input-group">
                  <span>Password</span>
                  <span class="root-password-field">
                    <input name="current-password" type="${state.showPassword ? "text" : "password"}" placeholder="Enter password" autocomplete="current-password" data-private-input data-auth-password readonly required minlength="8" />
                    <button type="button" data-action="togglePassword" aria-label="Toggle password visibility">${state.showPassword ? icons.eyeOff : icons.eye}</button>
                  </span>
                </label>
                <div class="root-links">
                  <button type="button" data-action="rootRecover">Recover key</button>
                  <strong>Gate 1 of 2</strong>
                </div>
              `}
              ${state.authError ? `<p class="root-auth-error">${escapeHtml(state.authError)}</p>` : ""}
              <button class="root-submit ${state.authSubmitting === "login" ? "is-loading" : ""}" type="submit" ${state.authSubmitting === "login" ? "disabled" : ""}>${state.authSubmitting === "login" ? loadingIcon() : ""}<span>${escapeHtml(state.authSubmitting === "login" ? "Authenticating..." : rootStep === "secret" ? "Verify Phrase" : "Continue")}</span></button>
            </form>
            <div class="root-status"><span></span> Secure connection active</div>
            <button class="root-return" type="button" data-route="home">Return to site</button>
          </div>
        </div>
      </section>
      ${rootRecoverModal()}
    </main>
  `, { auth: true });
}

function rootRecoverModal() {
  if (!state.rootRecoverOpen) return "";
  const email = String(state.rootRecoverEmail || state.rootEmail || "").trim().toLowerCase();
  const sending = state.authSubmitting === "root-reset-link";
  return `<div class="root-recover-layer" role="presentation">
    <button class="root-recover-scrim" type="button" data-action="closeRootRecover" aria-label="Close root recovery" ${sending ? "disabled" : ""}></button>
    <section class="root-recover-modal" role="dialog" aria-modal="true" aria-labelledby="root-recover-title">
      <div class="root-terminal-label">&gt; RECOVER_KEY</div>
      <h2 id="root-recover-title">Recover Key</h2>
      <p>Enter the configured Super Admin email. A reset link will be sent only if the address matches the root policy.</p>
      <form data-root-recover-form>
        <label class="root-input-group">
          <span>Super Admin Email</span>
          <input name="rootRecoverEmail" type="email" value="${escapeHtml(email)}" placeholder="admin.nexaa@gmail.com" autocomplete="username" autocapitalize="none" spellcheck="false" required />
        </label>
        <div class="root-recover-actions">
          <button type="button" data-action="closeRootRecover" ${sending ? "disabled" : ""}>Cancel</button>
          <button class="root-submit ${sending ? "is-loading" : ""}" type="submit" ${sending ? "disabled" : ""}>${sending ? loadingIcon() : ""}<span>${escapeHtml(sending ? "Sending..." : "Send Reset Link")}</span></button>
        </div>
      </form>
    </section>
  </div>`;
}

function adminDashboard() {
  if (!hasAdminAccess()) return adminLogin();
  const stats = adminStats();
  const recentUsers = (state.liveAdmin.loaded ? state.liveAdmin.users : appData.users).slice(0, 4);
  const superAdmin = isSuperAdmin();
  const adminName = superAdmin ? "DCYPHER X" : currentName();
  const adminRole = superAdmin ? "SUPER ADMIN" : "ADMIN";
  const dashboardTitle = superAdmin ? adminSettings.dashboardTitle || "Root Control Center" : "Admin Dashboard";
  const welcomeText = superAdmin
    ? adminSettings.welcomeText
    : "Manage archive users, uploads, reviews, and search operations without root system controls.";
  const inOverview = state.adminView === "overview";
  return shell(`
    <main class="admin-page admin-shell ${superAdmin ? "super-admin-page" : "regular-admin-page"}" data-panel-shell="admin">
      <section class="admin-hero${activeTourAnchor("hero")}" data-tour-anchor="hero">
        ${adminProfileAvatar(adminName)}
        <div>
          <h1>${escapeHtml(adminName)}</h1>
          <p><span class="root-pill">${icons.terminal} ${escapeHtml(adminRole)} ${superAdmin ? icons.spark : ""}</span> ${escapeHtml(dashboardTitle)}</p>
          <small>${escapeHtml(welcomeText)}</small>
        </div>
        ${tourStartButton()}
      </section>

      ${adminScreenNav(superAdmin)}
      ${state.liveAdmin.error ? `<section class="admin-inline-error">${escapeHtml(state.liveAdmin.error)}</section>` : ""}
      ${inOverview ? adminOverview(stats, recentUsers, superAdmin) : `<section class="admin-detail">${adminDetail(stats)}</section>`}
    </main>
  `, { admin: true });
}

function sentinelPage() {
  if (!isSuperAdmin()) return adminLogin();
  state.adminView = "security-center";
  return shell(`
    <main class="admin-page admin-shell super-admin-page sentinel-page" data-panel-shell="admin">
      <section class="admin-hero sentinel-standalone-hero">
        <span class="admin-avatar">${icons.shield}</span>
        <div>
          <h1>Sentinel</h1>
          <p><span class="root-pill">${icons.terminal} ROOT SECURITY</span> Independent security console</p>
          <small>Monitor root status, audit posture, security events, and lockdown controls outside the dashboard workspace.</small>
        </div>
      </section>
      <section class="admin-detail">${adminDetail(adminStats())}</section>
    </main>
  `, { admin: true });
}

function adminScreenNav(superAdmin) {
  const screens = superAdmin
    ? [
      ["overview", "Overview", "System health", icons.eye],
      ["root-control", "Root", "Global controls", icons.spark],
      ["admin-panel", "People", "Roles and access", icons.users],
      ["reviews", "Reviews", "Approval queue", icons.clock],
      ["messages", "Messages", "Google replies", icons.mail],
      ["audit-log", "Audit", "Trace actions", icons.terminal],
    ]
    : [
      ["overview", "Overview", "System summary", icons.eye],
      ["admin-panel", "Users", "Accounts and staff IDs", icons.users],
      ["reviews", "Reviews", "Approve uploads", icons.clock],
      ["upload", "Upload", "Add content", icons.upload],
      ["search-admin", "Search", "Archive query", icons.search],
      ["audit-log", "Audit", "Trace actions", icons.terminal],
    ];
  return `<nav class="admin-screen-nav" aria-label="Admin screens">
    ${screens
      .map(
        ([command, title, desc, icon]) => `<button class="${state.adminView === command ? "active" : ""}" data-admin-command="${command}">
          <span>${icon}</span>
          <strong>${title}</strong>
          <small>${desc}</small>
        </button>`
      )
      .join("")}
  </nav>`;
}

function adminOverview(stats, recentUsers, superAdmin) {
  return `
    <section class="admin-section${activeTourAnchor("stats")}" data-tour-anchor="stats">
      <div class="admin-section-title">
        <div>
          <h2>${icons.eye} System Overview</h2>
          <p>Live status, role scope, archive records, and recent platform activity.</p>
        </div>
        <span>${formatTime(new Date().toISOString())}</span>
      </div>
      <div class="admin-stats">
        ${adminStat(stats.totalUsers, "Total Users", icons.users)}
        ${adminStat(stats.students, "Students", icons.users)}
        ${adminStat(stats.staff, "Staff", icons.staff)}
        ${adminStat(stats.admins, "Admins", icons.shield)}
        ${adminStat(stats.projects, "Projects", icons.file)}
        ${adminStat(stats.materials, "Materials", icons.book)}
      </div>
    </section>

    ${superAdmin ? superAdminStatusGrid() : ""}
    ${roleFunctionPanel()}

    <section class="admin-grid">
      <div class="admin-section">
        <div class="admin-section-title">
          <div><h2>${icons.users} Recent Users</h2><p>Newest accounts and active role holders.</p></div>
          <button class="admin-link-button" data-admin-command="admin-panel">Manage Users</button>
        </div>
        <div class="recent-users">
          ${recentUsers.length ? recentUsers.map(userRow).join("") : `<div class="empty-users">No users yet</div>`}
        </div>
      </div>
      <div class="admin-section">
        <div class="admin-section-title">
          <div><h2>${icons.terminal} Activity Stream</h2><p>Approvals, sign-ins, account changes, and admin commands.</p></div>
          <button class="admin-link-button" data-admin-command="audit-log">Open Audit</button>
        </div>
        ${activityTerminal()}
      </div>
    </section>
  `;
}

function superAdminStatusGrid() {
  const notificationCount = state.liveAdmin.loaded ? Number(state.liveAdmin.notifications?.length || 0) : Number(adminSettings.notifications?.length || 0);
  return `<section class="super-admin-status-grid">
    <article><span>${icons.spark}</span><strong>${escapeHtml(adminSettings.theme || "Nexaa")}</strong><p>Active Theme</p></article>
    <article><span>${icons.shield}</span><strong>${adminSettings.maintenanceEnabled ? "Maintenance" : "Online"}</strong><p>System Mode</p></article>
    <article><span>${icons.bell}</span><strong>${notificationCount}</strong><p>Admin Notices</p></article>
    <article><span>${icons.users}</span><strong>${escapeHtml(adminSettings.defaultAdminRole || "Admin")}</strong><p>Default Admin Role</p></article>
  </section>`;
}

function superAdminRootPanel() {
  const adminUsers = state.liveAdmin.loaded ? state.liveAdmin.users : appData.users;
  const adminUploads = state.liveAdmin.loaded ? state.liveAdmin.uploads : staffWorkspaceUploads(true);
  const pendingStaff = adminUsers.filter((user) => isPendingStatus(user.status)).length;
  const pendingReviews = adminUploads.filter((item) => item.status === "Pending Review").length;
  const rootAccent = ["Gold", "Emerald"].includes(adminSettings.accent) ? adminSettings.accent : "Gold";
  return `<div class="super-admin-root-grid">
    <section class="super-root-panel root-priority">
      <div class="super-root-head">
        <span>${icons.spark}</span>
        <div>
          <h2>Root Command</h2>
          <p>System-wide controls for Nexaa operations, access, messaging, and lockdown.</p>
        </div>
      </div>
      <div class="root-command-grid">
        <article><strong>${adminSettings.maintenanceEnabled ? "Maintenance" : "Online"}</strong><span>System Mode</span></article>
        <article><strong>${pendingStaff}</strong><span>Pending Staff</span></article>
        <article><strong>${pendingReviews}</strong><span>Review Queue</span></article>
        <article><strong>${state.liveAdmin.loaded ? state.liveAdmin.notifications.length : adminSettings.notifications?.length || 0}</strong><span>Messages Sent</span></article>
      </div>
    </section>

    <form class="admin-form admin-customizer super-root-panel" data-admin-customizer>
      <h2>System Controls</h2>
      <p>Set platform mode, default admin scope, and global dashboard messaging.</p>
      <label>Theme Name<input name="theme" value="${escapeHtml(adminSettings.theme)}" placeholder="Nexaa Classic" /></label>
      <label>Dashboard Title<input name="dashboardTitle" value="${escapeHtml(adminSettings.dashboardTitle)}" placeholder="Root Control Center" /></label>
      <label>Welcome Text<textarea name="welcomeText" placeholder="Welcome text">${escapeHtml(adminSettings.welcomeText)}</textarea></label>
      <div class="form-grid two">
        <label>Accent<select name="accent"><option ${rootAccent === "Gold" ? "selected" : ""}>Gold</option><option ${rootAccent === "Emerald" ? "selected" : ""}>Emerald</option></select></label>
        <label>Default Admin Role<select name="defaultAdminRole"><option ${adminSettings.defaultAdminRole === "Admin" ? "selected" : ""}>Admin</option><option ${adminSettings.defaultAdminRole === "Department Admin" ? "selected" : ""}>Department Admin</option><option ${adminSettings.defaultAdminRole === "Faculty Admin" ? "selected" : ""}>Faculty Admin</option></select></label>
      </div>
      <label class="toggle-line root-toggle"><input type="checkbox" name="maintenanceEnabled" ${adminSettings.maintenanceEnabled ? "checked" : ""} /> Maintenance mode</label>
      <label>Maintenance Message<textarea name="maintenanceMessage" placeholder="Maintenance message">${escapeHtml(adminSettings.maintenanceMessage || defaultAdminSettings.maintenanceMessage)}</textarea></label>
      <div class="admin-form-divider"></div>
      <h2>Broadcast Message</h2>
      <p>Send user-facing messages only: completed updates, admin replies, and important notices.</p>
      <label>Notify Role<select name="notificationRole"><option value="">No message</option><option value="all">All users</option><option value="student">Students</option><option value="staff">Staff</option><option value="hod">HOD</option><option value="admin">Admins</option></select></label>
      <label>Message Title<input name="notificationTitle" placeholder="e.g. Welcome to Nexaa" /></label>
      <label>Message Body<textarea name="notificationBody" placeholder="Short update for selected users"></textarea></label>
      <button class="auth-submit" type="submit">${icons.spark}<span>Save Root Settings</span></button>
    </form>

    <section class="super-root-panel">
      <div class="super-root-head">
        <span>${icons.users}</span>
        <div>
          <h2>Role Governance</h2>
          <p>Super Admin approves admins, can approve staff, and controls root-only configuration.</p>
        </div>
      </div>
      <div class="root-policy-list">
        <article><b>Students</b><span>Self-service signup after OTP and profile completion.</span></article>
        <article><b>Staff</b><span>Request access with FUTA email and await HOD or Super Admin approval.</span></article>
        <article><b>Admin</b><span>Created/promoted only through Super Admin governance.</span></article>
        <article><b>Super Admin</b><span>Root-only control over maintenance, global messages, and audit/security.</span></article>
      </div>
    </section>

    <section class="super-root-panel database-scope">
      <div class="super-root-head">
        <span>${icons.terminal}</span>
        <div>
          <h2>Database Scope</h2>
          <p>Prepared for institution, faculty, department, programme, uploads, and review expansion.</p>
        </div>
      </div>
      <div class="scope-grid">
        <span><strong>${appData.institutions.length}</strong> Universities</span>
        <span><strong>${appData.faculties.length}</strong> Faculties</span>
        <span><strong>${appData.departments.length}</strong> Departments</span>
        <span><strong>${appData.programmes.length}</strong> Programmes</span>
      </div>
    </section>
  </div>`;
}

const sentinelModules = [
  ["overview", "Overview", "Guard plane", icons.shield],
  ["threats", "Threats", "Risk scoring", icons.eye],
  ["lockdown", "Lockdown", "Emergency state", icons.lock],
  ["monitoring", "Monitoring", "Live telemetry", icons.clock],
  ["audit", "Audit", "Trace logs", icons.terminal],
  ["alerts", "Alerts", "Response queue", icons.bell],
  ["backup", "Backup", "Recovery points", icons.download],
  ["access", "Access", "Roles and MFA", icons.users],
  ["archive", "Archive", "File integrity", icons.file],
  ["settings", "Infra", "Policies", icons.settings],
];

const sentinelModeMeta = {
  normal: ["NORMAL", "All archive services are accepting authenticated traffic."],
  warning: ["WARNING", "Monitoring sensitivity raised for suspicious request clusters."],
  lockdown: ["LOCKDOWN", "Writes are frozen, uploads restricted, and mutation APIs blocked."],
  maintenance: ["MAINTENANCE", "Scheduled controls are active while service windows are supervised."],
};

const sentinelThreatRows = [
  ["104.21.32.18", "8,942", "Blocked", 94, "14 sec ago"],
  ["196.45.102.9", "4,188", "Monitored", 72, "38 sec ago"],
  ["41.203.71.11", "1,207", "Allowed", 31, "2 min ago"],
  ["172.64.80.45", "6,335", "Challenged", 81, "4 min ago"],
  ["102.89.12.108", "903", "Allowed", 22, "8 min ago"],
];

function sentinelMetric(name, fallback = 0) {
  return state.liveSecurity.metrics && Object.hasOwn(state.liveSecurity.metrics, name) ? state.liveSecurity.metrics[name] : fallback;
}

function titleText(value = "") {
  return String(value || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function sentinelThreatItems() {
  if (state.liveSecurity.threats?.length) return state.liveSecurity.threats;
  return sentinelThreatRows.map(([ip, requests, status, score, last]) => ({
    ip,
    requests,
    status,
    score,
    lastSeenLabel: last,
    category: status === "Blocked" ? "Brute force" : status === "Challenged" ? "API abuse" : "Unusual traffic",
  }));
}

function sentinelLogItems() {
  if (state.liveSecurity.logs?.length) return state.liveSecurity.logs;
  return appData.activity.length ? appData.activity.slice(0, 12) : [
    { at: new Date().toISOString(), type: "Info", actor: "Sentinel", message: "No live audit entries yet. Security framework is ready." },
  ];
}

function sentinelAlertItems() {
  if (state.liveSecurity.alerts?.length) return state.liveSecurity.alerts;
  return [
    { severity: "emergency", title: "Credential spray against admin route", status: "open" },
    { severity: "critical", title: "Blocked IP exceeded adaptive threshold", status: "acknowledged" },
    { severity: "warning", title: "Bulk download anomaly", status: "investigating" },
    { severity: "info", title: "Backup verification completed", status: "resolved" },
  ];
}

function sentinelSettingsGroups() {
  const settings = state.liveSecurity.settings || {};
  return {
    policies: settings.policies || { "Rate limits": "1,200 req/min", "Timeout rules": "12 min admin", "Lock thresholds": "10 failed attempts", "Archive write window": "06:00-23:00" },
    apiControls: settings.apiControls || { "API keys": "Server only", "Token status": "Access-token only", "Endpoint restrictions": "Mutation protected", "Webhook signing": "Required" },
    infrastructure: settings.infrastructureControls?.controls || ["Gateway monitor", "Storage sentinel", "Backup verifier", "Role anomaly model", "Alert router", "Geo challenge engine"],
  };
}

function superAdminSecurityPanel() {
  const current = sentinelModules.find(([id]) => id === state.sentinelView) || sentinelModules[0];
  const [modeLabel, modeDesc] = sentinelModeMeta[state.sentinelMode] || sentinelModeMeta.normal;
  return `<section class="admin-screen super-security-panel sentinel-console" data-sentinel-mode="${escapeHtml(state.sentinelMode)}">
    <div class="admin-screen-head sentinel-head">
      <div>
        <h2>${current[3]} ${escapeHtml(current[1])}</h2>
        <p>${escapeHtml(current[2])}: Super Admin security implementation framework for Nexaa.</p>
      </div>
      <span>${escapeHtml(modeLabel)}</span>
    </div>
    ${state.liveSecurity.error ? `<div class="support-inbox-error sentinel-error">${escapeHtml(state.liveSecurity.error)}</div>` : ""}
    <div class="sentinel-mode-strip">
      <div class="sentinel-mode-copy"><i></i><strong>${escapeHtml(modeLabel)}</strong><small>${escapeHtml(modeDesc)}</small></div>
      <div class="sentinel-mode-actions">
        ${Object.keys(sentinelModeMeta).map((mode) => `<button class="${state.sentinelMode === mode ? "active" : ""}" data-sentinel-mode-target="${mode}">${escapeHtml(sentinelModeMeta[mode][0])}</button>`).join("")}
      </div>
    </div>
    <nav class="sentinel-module-nav" aria-label="Sentinel modules">
      ${sentinelModules.map(([id, title, desc, icon]) => `<button class="${state.sentinelView === id ? "active" : ""}" data-sentinel-view="${id}"><span>${icon}</span><strong>${title}</strong><small>${desc}</small></button>`).join("")}
    </nav>
    ${sentinelViewContent(state.sentinelView)}
  </section>`;
}

function sentinelViewContent(view = "overview") {
  if (view === "threats") return sentinelThreatsView();
  if (view === "lockdown") return sentinelLockdownView();
  if (view === "monitoring") return sentinelMonitoringView();
  if (view === "audit") return sentinelAuditView();
  if (view === "alerts") return sentinelAlertsView();
  if (view === "backup") return sentinelBackupView();
  if (view === "access") return sentinelAccessView();
  if (view === "archive") return sentinelArchiveView();
  if (view === "settings") return sentinelSettingsView();
  return sentinelOverviewView();
}

function sentinelOverviewView() {
  const activeThreats = sentinelMetric("activeThreats", 4);
  const blockedAttacks = sentinelMetric("blockedAttacks", 128);
  const openAlerts = sentinelMetric("openAlerts", 0);
  return `<div class="sentinel-grid">
    <article class="sentinel-card sentinel-hero">
      <div class="sentinel-map"><span></span><span></span><span></span><i></i><i></i><i></i></div>
      <div><h3>NEXA archive guard plane</h3><p>Observing authentication, API gateways, storage writes, document integrity, and external access points in real time.</p>${sentinelMetricRow([[sentinelMetric("serviceHealth", "99.98%"), "Service health"], [sentinelMetric("auditEvents", appData.activity.length), "Audit events"], [sentinelMetric("knownUsers", appData.users.length), "Known users"]])}</div>
    </article>
    ${sentinelHealthCard()}
    <article class="sentinel-card"><h3>Threat Overview</h3>${sentinelMetricGrid([["Active threats", activeThreats, activeThreats ? "warning" : "success"], ["Blocked attacks", blockedAttacks, blockedAttacks ? "danger" : "success"], ["Open alerts", openAlerts, openAlerts ? "warning" : "success"], ["Suspicious IPs", sentinelThreatItems().filter((item) => item.status !== "Allowed").length, "warning"]])}</article>
    <article class="sentinel-card wide"><h3>Activity Feed</h3>${sentinelEventFeed()}</article>
    <article class="sentinel-card"><h3>User Activity</h3>${sentinelMetricGrid([["Active sessions", "312", ""], ["Admin sessions", String(appData.users.filter((user) => /admin/i.test(user.role)).length), ""], ["Geo points", "18", ""], ["MFA coverage", "96%", "success"]])}</article>
  </div>`;
}

function sentinelThreatsView() {
  return `<div class="sentinel-grid">
    <article class="sentinel-card wide"><h3>Threat Timeline</h3>${sentinelTimeline()}</article>
    <article class="sentinel-card"><h3>Threat Categories</h3>${sentinelCategoryStack()}</article>
    <article class="sentinel-card"><h3>Real-Time Threat Graph</h3>${sentinelMiniBars([18,22,31,28,45,39,66,50,74,82,49,42,34,68,58,46,61,72])}</article>
    <article class="sentinel-card full"><h3>IP Monitoring</h3>${sentinelIpTable()}</article>
  </div>`;
}

function sentinelLockdownView() {
  return `<div class="sentinel-grid">
    <article class="sentinel-card full sentinel-command"><div><h3>Emergency State Switcher</h3><p>Activate controlled restrictions only when threat confidence justifies interrupting academic archive workflows.</p></div><button data-sentinel-mode-target="lockdown">${icons.lock}<span>Activate Lockdown</span></button></article>
    <article class="sentinel-card wide"><h3>Affected Systems</h3>${sentinelSystemGrid(["Archive upload gateway", "Document edit service", "Metadata write API", "Bulk export worker", "Role mutation endpoint", "Backup scheduler"])}</article>
    <article class="sentinel-card"><h3>Lockdown Effects</h3>${sentinelChecklist(["Restricted uploads", "Disabled editing", "Frozen write operations", "Privileged session review"])}</article>
  </div>`;
}

function sentinelMonitoringView() {
  const monitoring = state.liveSecurity.monitoring || {};
  const usage = monitoring.resourceUsage || {};
  const connections = Array.isArray(monitoring.activeConnections) && monitoring.activeConnections.length
    ? monitoring.activeConnections.map((item) => item.city || item.label || item.name || String(item)).slice(0, 6)
    : ["Lagos", "Abuja", "London", "Accra"];
  return `<div class="sentinel-grid">
    <article class="sentinel-card"><h3>Live Request Monitoring</h3>${sentinelMetricGrid([["Requests/sec", monitoring.requestsPerSecond || "1,284", ""], ["API usage", `${monitoring.apiUsagePercent || 78}%`, "warning"], ["Suspicious routes", monitoring.suspiciousRoutes || 9, "danger"], ["Avg response", `${monitoring.averageResponseMs || 42}ms`, "success"]])}</article>
    <article class="sentinel-card wide"><h3>Active Connections</h3><div class="sentinel-connection-map">${connections.map((city) => `<b>${escapeHtml(city)}</b>`).join("")}</div></article>
    <article class="sentinel-card wide"><h3>Traffic Heatmap</h3>${sentinelHeatmap()}</article>
    <article class="sentinel-card"><h3>Resource Usage</h3>${sentinelCategoryStack([["CPU", usage.CPU ?? 48, "success"], ["RAM", usage.RAM ?? 62, ""], ["Storage", usage.Storage ?? 73, "warning"], ["Bandwidth", usage.Bandwidth ?? 54, ""]])}</article>
  </div>`;
}

function sentinelAuditView() {
  return `<div class="sentinel-grid"><article class="sentinel-card full"><div class="sentinel-card-head"><h3>Audit Log Center</h3><div>${["User", "Date", "Severity", "Module", "Action"].map((item) => `<button class="sentinel-filter" data-sentinel-filter>${item}</button>`).join("")}</div></div>${sentinelLogList()}</article></div>`;
}

function sentinelAlertsView() {
  const alerts = sentinelAlertItems();
  return `<div class="sentinel-grid">
    <article class="sentinel-card wide"><h3>Alert Queue</h3><div class="sentinel-alert-grid">${alerts.map((alert) => {
      const status = String(alert.status || "open").toLowerCase();
      const nextStatus = status === "open" ? "acknowledged" : status === "acknowledged" ? "investigating" : status === "investigating" ? "resolved" : "resolved";
      return `<article class="${escapeHtml(alert.severity || "info")}"><strong>${escapeHtml(titleText(alert.severity || "info"))}</strong><p>${escapeHtml(alert.title || "Security alert")}</p><button data-sentinel-alert-id="${escapeHtml(alert.id || "")}" data-sentinel-alert-status="${escapeHtml(nextStatus)}">${escapeHtml(status === "resolved" ? "Resolved" : `Mark ${titleText(nextStatus)}`)}</button></article>`;
    }).join("")}</div></article>
    <article class="sentinel-card"><h3>Channels</h3>${sentinelStatusList([["Telegram","Online"],["Email","Online"],["SMS","Degraded"],["Gmail","Online"]])}</article>
    <article class="sentinel-card full"><h3>Resolution History</h3>${sentinelChecklist(["Critical alert acknowledged in 3m 12s", "Warning routed to Telegram and Email", "Emergency policy dry-run completed", "Archive integrity alert resolved"])}</article>
  </div>`;
}

function sentinelBackupView() {
  const backups = state.liveSecurity.backups?.length ? state.liveSecurity.backups : [
    { label: "02:00", size: "81.4 GB", status: "Successful", integrity: "Verified" },
    { label: "20:00", size: "80.9 GB", status: "Successful", integrity: "Verified" },
    { label: "14:00", size: "80.1 GB", status: "Warning", integrity: "Rechecking" },
    { label: "08:00", size: "79.8 GB", status: "Successful", integrity: "Verified" },
  ];
  return `<div class="sentinel-grid">
    <article class="sentinel-card wide"><h3>Backup History</h3>${sentinelTable(["Timestamp", "Size", "Status", "Integrity"], backups.map((item) => [item.label || formatTime(item.createdAt), item.size || "", item.status || "", item.integrity || ""]))}</article>
    ${sentinelHealthCard(["Object store", "Checksum scan", "Snapshot index", "Cold archive"])}
    <article class="sentinel-card full sentinel-command"><div><h3>Recovery Points</h3><p>Preview rollback scope and estimated recovery before restoring protected archive state.</p></div><button data-sentinel-toast="Restore preview prepared. Estimated recovery time: 11 minutes.">${icons.download}<span>Preview Restore</span></button></article>
  </div>`;
}

function sentinelAccessView() {
  const rows = appData.users.slice(0, 8).map((user) => [user.name, user.role, user.department || "Archive", user.status || "Active", "MFA", formatTime(user.lastSeen)]);
  return `<div class="sentinel-grid">
    <article class="sentinel-card full"><h3>Users, Roles & Permissions</h3>${sentinelTable(["User", "Role", "Permissions", "Session", "MFA", "Login history"], rows)}</article>
    <article class="sentinel-card"><h3>Role Management</h3>${sentinelSystemGrid(["Super Admin", "Admin", "Staff", "Student"])}</article>
    <article class="sentinel-card wide"><h3>Permission Change Logs</h3>${sentinelTimeline("access")}</article>
  </div>`;
}

function sentinelArchiveView() {
  return `<div class="sentinel-grid">
    <article class="sentinel-card"><h3>File Integrity</h3>${sentinelMetricGrid([["Missing files","0","success"],["Corruption checks","99.9%","success"],["Suspicious downloads","3","warning"],["Protected paths",String(archiveProjects().length + archiveMaterials().length),""]])}</article>
    <article class="sentinel-card wide"><h3>Storage Mapping</h3>${sentinelSystemGrid(["Projects", "Materials", "Protected files", "Backups", "Indexes", "Review queue"])}</article>
    <article class="sentinel-card full"><h3>Upload Monitoring</h3>${sentinelTable(["Upload source", "Size", "Verification", "Status", "Time"], [["staff-portal","24 MB","Checksum pass","Accepted","03:08"],["library-node-4","912 MB","Malware scan","Pending","03:02"],["external-review","13 MB","Policy hold","Monitored","02:57"],["bulk-ingest","4.8 GB","Checksum pass","Accepted","02:30"]])}</article>
  </div>`;
}

function sentinelSettingsView() {
  const groups = sentinelSettingsGroups();
  return `<div class="sentinel-grid">
    <article class="sentinel-card"><h3>Security Policies</h3>${sentinelToggleList(Object.entries(groups.policies))}</article>
    <article class="sentinel-card"><h3>API Security</h3>${sentinelToggleList(Object.entries(groups.apiControls))}</article>
    <article class="sentinel-card wide"><h3>Infrastructure Controls</h3>${sentinelSystemGrid(groups.infrastructure)}</article>
  </div>`;
}

function sentinelBadge(text = "") {
  return `<span class="sentinel-badge ${String(text).toLowerCase().replace(/\s+/g, "-")}">${escapeHtml(text)}</span>`;
}

function sentinelMeter(value, tone = "") {
  return `<span class="sentinel-meter ${tone}"><i style="width:${Math.max(0, Math.min(100, Number(value) || 0))}%"></i></span>`;
}

function sentinelMetricRow(items) {
  return `<div class="sentinel-metric-row">${items.map(([value, label]) => `<span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></span>`).join("")}</div>`;
}

function sentinelMetricGrid(items) {
  return `<div class="sentinel-metric-grid">${items.map(([label, value, tone]) => `<div class="${tone || ""}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>`;
}

function sentinelMiniBars(values) {
  return `<div class="sentinel-mini-bars">${values.map((value) => `<i style="height:${Math.max(8, Math.min(100, Number(value) || 0))}%"></i>`).join("")}</div>`;
}

function sentinelHealthCard(names = ["Server status", "API health", "DB status", "Storage health"]) {
  return `<article class="sentinel-card"><h3>System Health</h3>${sentinelStatusList(names.map((name, index) => [name, index === 2 ? "Replicated" : "Healthy"]))}</article>`;
}

function sentinelStatusList(rows) {
  return `<div class="sentinel-status-list">${rows.map(([name, value]) => `<div><span><i class="${/degraded|warning/i.test(value) ? "warning" : "success"}"></i>${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>`;
}

function sentinelEventFeed() {
  const logs = sentinelLogItems().slice(0, 5);
  const fallback = [
    { at: new Date().toISOString(), message: "Security center opened", type: "SECURITY", actor: currentName() },
    { at: new Date().toISOString(), message: "Archive write gate healthy", type: "INFO", actor: "Sentinel" },
  ];
  return `<div class="sentinel-feed">${(logs.length ? logs : fallback).map((log) => `<div><time>${formatTime(log.at)}</time><span>${escapeHtml(log.message)}</span>${sentinelBadge(log.type || "Info")}<small>${escapeHtml(log.actor || "System")}</small></div>`).join("")}</div>`;
}

function sentinelTimeline(type = "threat") {
  const rows = type === "access"
    ? [["02:33", "Observer role reviewed", "Info"], ["02:19", "MFA challenge passed", "Info"], ["02:05", "Permission elevation denied", "Warning"], ["01:58", "Dormant admin session killed", "High"]]
    : [["02:25", "API abuse pattern isolated", "High"], ["02:15", "Credential spray blocked", "Critical"], ["01:44", "Suspicious download burst", "Medium"], ["01:18", "Unusual traffic from edge node", "Low"]];
  return `<div class="sentinel-timeline">${rows.map(([time, text, sev]) => `<div><time>${time}</time><i></i><span>${escapeHtml(text)}</span>${sentinelBadge(sev)}</div>`).join("")}</div>`;
}

function sentinelCategoryStack(rows = [["Brute force",86,"danger"],["Unusual traffic",64,"warning"],["Suspicious downloads",43,"warning"],["Role abuse",22,""],["API abuse",71,"danger"]]) {
  return `<div class="sentinel-category-stack">${rows.map(([name, value, tone]) => `<div><span>${escapeHtml(name)}</span>${sentinelMeter(value, tone)}<strong>${escapeHtml(value)}${Number.isFinite(Number(value)) ? "%" : ""}</strong></div>`).join("")}</div>`;
}

function sentinelIpTable() {
  return sentinelTable(["IP address", "Requests", "Status", "Threat score", "Last activity"], sentinelThreatItems().map((item) => {
    const score = Number(item.score || 0);
    return [item.ip, Number(item.requests) ? Number(item.requests).toLocaleString() : item.requests, sentinelBadge(item.status), sentinelMeter(score, score > 80 ? "danger" : score > 60 ? "warning" : "success"), item.lastSeenLabel || formatTime(item.lastSeen)];
  }), true);
}

function sentinelTable(headers, rows, raw = false) {
  return `<div class="sentinel-table"><div class="sentinel-thead">${headers.map((header) => `<span>${escapeHtml(header)}</span>`).join("")}</div>${rows.map((row) => `<div class="sentinel-tr">${row.map((cell) => `<span>${raw ? cell : escapeHtml(cell)}</span>`).join("")}</div>`).join("")}</div>`;
}

function sentinelSystemGrid(items) {
  return `<div class="sentinel-system-grid">${items.map((item, index) => `<div><span>${index % 2 ? icons.file : icons.shield}</span><strong>${escapeHtml(item)}</strong><small>${index < 3 ? "Supervised" : "Protected"}</small></div>`).join("")}</div>`;
}

function sentinelChecklist(items) {
  return `<div class="sentinel-checklist">${items.map((item) => `<div>${icons.check}<span>${escapeHtml(item)}</span></div>`).join("")}</div>`;
}

function sentinelHeatmap() {
  const values = state.liveSecurity.monitoring?.heatmap?.length ? state.liveSecurity.monitoring.heatmap : Array.from({ length: 84 }, (_, index) => (index * 7) % 5);
  return `<div class="sentinel-heatmap">${values.slice(0, 84).map((value) => `<i class="h${Math.max(0, Math.min(4, Number(value) || 0))}"></i>`).join("")}</div>`;
}

function sentinelLogList() {
  const logs = sentinelLogItems().slice(0, 12);
  return `<div class="sentinel-log-list">${logs.map((log, index) => {
    const id = `${formatTime(log.at)}-${index}`;
    const expanded = state.sentinelExpandedLog === id;
    return `<article class="${expanded ? "expanded" : ""}" data-sentinel-log="${escapeHtml(id)}"><div><time>${formatTime(log.at)}</time><strong>${escapeHtml(log.message)}</strong><span>${escapeHtml(log.actor || "System")}</span>${sentinelBadge(log.type || "Info")}${icons.chevronDown}</div><p>Related action indexed against authentication, gateway, archive storage, or Super Admin controls.</p></article>`;
  }).join("")}</div>`;
}

function sentinelToggleList(items) {
  return `<div class="sentinel-toggle-list">${items.map(([label, value]) => `<label><span>${escapeHtml(label)}<small>${escapeHtml(value)}</small></span><input type="checkbox" checked /></label>`).join("")}</div>`;
}

function supportInboxItems() {
  const remote = state.liveSupport.requests || [];
  const seen = new Set(remote.map((item) => item.id));
  const local = (appData.supportRequests || [])
    .map((item) => frontendSupportRequest({
      id: item.id,
      email: item.email,
      subject: item.subject || `Support request from ${item.name || item.email || "user"}`,
      message: item.message,
      status: item.status,
      created_at: item.at,
    }))
    .filter((item) => !seen.has(item.id));
  return [...remote, ...local].sort((a, b) => new Date(b.updatedAt || b.at) - new Date(a.updatedAt || a.at));
}

function superAdminMessagesPanel() {
  const requests = supportInboxItems();
  return `<section class="admin-screen super-messages-panel">
    <div class="admin-screen-head messages-screen-head">
      <div>
        <div class="panel-title-row"><h2>${icons.mail} Messages</h2><span>${state.liveSupport.loading ? "syncing" : `${requests.length} messages`}</span></div>
        <p>Support messages from users, with replies delivered through Gmail.</p>
      </div>
      <button class="admin-link-button" data-admin-command="refresh-messages">${icons.download}<span>Refresh inbox</span></button>
    </div>
    ${state.liveSupport.error ? `<div class="support-inbox-error">${escapeHtml(state.liveSupport.error)}</div>` : ""}
    <div class="support-message-list">
      ${requests.length ? requests.map(supportMessageCard).join("") : polishedEmpty("No support messages yet", "User help requests will appear here once they contact the archive administrator.", icons.mail)}
    </div>
  </section>`;
}

function supportMessageCard(item) {
  const status = String(item.status || "open").toLowerCase();
  const isResolved = status === "resolved" || status === "closed" || Boolean(item.reply);
  return `<article class="support-message-card">
    <div class="support-message-main">
      <span>${icons.mail}</span>
      <div>
        <strong>${escapeHtml(item.subject || "Support message")}</strong>
        <small>${escapeHtml(item.email)} &middot; ${formatTime(item.at)} &middot; ${statusPill(isResolved ? "Resolved" : "Open")}</small>
        <p>${escapeHtml(item.message)}</p>
        ${item.reply ? `<blockquote>${escapeHtml(item.reply)}</blockquote>` : ""}
      </div>
    </div>
    <form class="support-reply-form" data-support-reply-form>
      <input type="hidden" name="supportRequestId" value="${escapeHtml(item.id)}" />
      <input type="hidden" name="to" value="${escapeHtml(item.email)}" />
      <label>Subject<input name="subject" value="${escapeHtml(`Re: ${item.subject || "Nexaa support"}`)}" required /></label>
      <label>Reply<textarea name="message" placeholder="Type your reply for this user..." required>${escapeHtml(item.reply ? "" : "")}</textarea></label>
      <button class="auth-submit" type="submit" ${state.liveSupport.replying === item.id ? "disabled" : ""}>${icons.mail}<span>${state.liveSupport.replying === item.id ? "Sending..." : "Send Gmail Reply"}</span></button>
    </form>
  </article>`;
}

function adminStat(value, label, icon) {
  return `<article class="admin-stat">${icon}<strong>${value}</strong><span>${label}</span></article>`;
}

function adminCommand(command, title, desc, icon) {
  return `<button class="admin-command ${state.adminView === command ? "active" : ""}" data-admin-command="${command}">
    <span>${icon}</span><strong>${title}</strong><p>${desc}</p><b>&rsaquo;</b>
  </button>`;
}

function userRow(user) {
  return `<article class="user-row"><span>${initials(user.name)}</span><div><div class="user-row-title"><strong>${escapeHtml(user.name)}</strong><em>${formatTime(user.lastSeen)}</em></div><small>${escapeHtml(user.role)} &middot; ${escapeHtml(user.email)}</small></div></article>`;
}

function activityTerminal() {
  const logs = appData.activity.slice(0, 8);
  return `<div class="terminal">
    <div class="terminal-bar"><span></span><span></span><span></span><p>${icons.terminal} nexa@admin:~/activity-log</p><button data-admin-command="expand-log" aria-label="Expand log">${icons.expand}</button></div>
    <div class="terminal-body">
      <p class="terminal-title"><i></i>Nexaa Activity Monitor</p>
      <p class="terminal-muted">Streaming admin actions in real-time...</p>
      <div class="terminal-lines">
        ${logs.length ? logs.map((log) => `<p><span>${formatTime(log.at)}</span> <b>[${escapeHtml(log.type)}]</b> ${escapeHtml(log.message)} <em>${escapeHtml(log.actor)}</em></p>`).join("") : `<p class="terminal-empty">~ No activity logs yet. Actions will appear here in real-time.</p>`}
      </div>
      <p class="terminal-prompt">&rsaquo;<i></i></p>
    </div>
    <div class="terminal-foot"><span>${appData.activity.length} entries</span><span><i></i> LIVE</span></div>
  </div>`;
}

function adminDetail(stats) {
  if (state.adminView === "upload") {
    return `<section class="admin-screen">
      <div class="admin-screen-head"><div><h2>Upload Content</h2><p>Add a reviewed ARE project or material into the archive.</p></div><span>${stats.projects + stats.materials} records</span></div>
      <form class="admin-form admin-wide-form" data-admin-upload>
        <label>Title<input name="title" placeholder="Archive title" required /></label>
        <div class="form-grid two">
          <label>Type<select name="kind"><option>Project</option><option>Material</option></select></label>
          <label>File Name<input name="fileName" placeholder="document.pdf" required /></label>
        </div>
        <label>Department<input name="department" value="${DEPARTMENT_NAME}" /></label>
        <button class="auth-submit" type="submit">${icons.upload}<span>Add Content</span></button>
      </form>
    </section>`;
  }
  if (state.adminView === "reviews") {
    const pending = (state.liveAdmin.loaded ? state.liveAdmin.uploads : staffWorkspaceUploads(true)).filter((item) => item.status === "Pending Review");
    return `<section class="admin-screen">
      <div class="admin-screen-head admin-screen-head-stacked"><div><div class="panel-title-row"><h2>Pending Reviews</h2><span>${pending.length} pending</span></div><p>Approve or reject staff uploads before students can see them.</p></div></div>
      <div class="admin-table">
        ${staffWorkspaceStatus()}
        ${pending.length ? pending.map(reviewRow).join("") : polishedEmpty("No pending reviews", "Approved items are already live in search.", icons.check)}
      </div>
    </section>`;
  }
  if (state.adminView === "users" || state.adminView === "admin-panel") {
    const activeTab = ["users", "staff-ids", "access"].includes(state.adminPanelTab) ? state.adminPanelTab : "users";
    const adminUsers = state.liveAdmin.loaded ? state.liveAdmin.users : appData.users;
    const staffIds = state.liveAdmin.loaded ? state.liveAdmin.staffIds : appData.staffIds;
    const pendingStaff = adminUsers.filter((user) => ["staff", "hod"].includes(roleKey(user)) && isPendingStatus(user.status));
    const tabButton = (tab, label) => `<button class="${activeTab === tab ? "active" : ""}" data-admin-tab="${tab}" type="button">${label}</button>`;
    const panelContent = activeTab === "staff-ids"
      ? `<article class="management-panel admin-tab-panel">
          <h3>${icons.staff} Staff IDs</h3>
          <p class="management-panel-copy">Review pending staff, authenticate access, and auto-generate staff IDs on approval.</p>
          <div class="staff-review-stack">
            <section>
              <div class="mini-section-head"><strong>Pending Staff Review</strong><span>${pendingStaff.length} pending</span></div>
              <div class="admin-table compact">${pendingStaff.length ? pendingStaff.map(pendingStaffReviewRow).join("") : polishedEmpty("No pending staff", "New staff verification requests will appear here in real time.", icons.check)}</div>
            </section>
            <section>
              <div class="mini-section-head"><strong>Generated Staff IDs</strong><span>${staffIds.length} IDs</span></div>
              <div class="admin-table compact">${staffIds.length ? staffIds.map(staffIdRow).join("") : polishedEmpty("No staff IDs yet", "Approving a pending staff account will generate one automatically.", icons.staff)}</div>
            </section>
          </div>
        </article>`
      : activeTab === "access"
        ? `<article class="management-panel admin-tab-panel">
            <h3>${icons.shield} Access</h3>
            <p class="management-panel-copy">Approve, suspend, promote, or demote role access from one place.</p>
            <div class="admin-table compact">${adminUsers.length ? adminUsers.map(adminAccessRow).join("") : polishedEmpty("No access records", "Accounts will appear here after signup.", icons.shield)}</div>
          </article>`
        : `<article class="management-panel admin-tab-panel">
            <div class="panel-title-row"><h3>${icons.users} Users</h3><span>${adminUsers.length} users</span></div>
            <p class="management-panel-copy">View registered students, staff, admins, and their current account state.</p>
            <div class="admin-table compact">${adminUsers.length ? adminUsers.map(adminUserSummaryRow).join("") : polishedEmpty("No users yet", "New accounts will appear here after signup.", icons.users)}</div>
            <div class="panel-actions"><button data-admin-command="seed-user">Add Student</button><button data-admin-command="seed-staff">Add Staff</button></div>
          </article>`;
    return `<section class="admin-screen">
      <div class="admin-screen-head"><div><h2>Admin Panel</h2><p>Manage users, review status, staff IDs, and account access for ${DEPARTMENT_NAME}.</p></div></div>
      <div class="admin-tabs">
        ${tabButton("users", "Users")}
        ${tabButton("staff-ids", "Staff IDs")}
        ${tabButton("access", "Access")}
      </div>
      <div class="admin-management-grid admin-management-grid-single">
        ${panelContent}
      </div>
    </section>`;
  }
  if (state.adminView === "root-control") {
    if (!isSuperAdmin()) {
      return `<section class="admin-screen">
        <div class="admin-screen-head"><div><h2>Super Admin Only</h2><p>Admin users can manage archive operations, but root settings and admin customization belong to the Super Admin.</p></div><span>restricted</span></div>
        <div class="admin-info"><h2>Admin Scope</h2><p>You can review uploads, manage archive users, search records, and add content. Super Admin controls system branding, root dashboard settings, and global admin roles.</p></div>
      </section>`;
    }
    return superAdminRootPanel();
  }
  if (state.adminView === "security-center") {
    if (!isSuperAdmin()) {
      return `<section class="admin-screen">
        <div class="admin-screen-head"><div><h2>Super Admin Only</h2><p>Security center is restricted to the Super Admin.</p></div><span>restricted</span></div>
      </section>`;
    }
    return superAdminSecurityPanel();
  }
  if (state.adminView === "messages") {
    if (!isSuperAdmin()) {
      return `<section class="admin-screen">
        <div class="admin-screen-head"><div><h2>Super Admin Only</h2><p>Messages and Gmail replies are restricted to the Super Admin.</p></div><span>restricted</span></div>
      </section>`;
    }
    return superAdminMessagesPanel();
  }
  if (state.adminView === "audit-log") {
    const liveLogs = state.liveSecurity.logs?.length ? state.liveSecurity.logs.map((log) => ({
      type: log.type || log.severity || "Info",
      actor: log.actor || "System",
      message: log.message || log.action || "Security event",
      at: log.at || log.createdAt,
    })) : [];
    const auditLogs = liveLogs.length ? liveLogs : appData.activity;
    return `<section class="admin-screen audit-screen">
      <div class="admin-screen-head admin-screen-head-stacked audit-screen-head"><div><div class="panel-title-row"><h2>Audit Log</h2><span>${auditLogs.length} events</span></div><p>Trace approvals, rejections, suspensions, uploads, sign-ins, and admin commands.</p></div></div>
      <div class="audit-list">
        ${auditLogs.length ? auditLogs.map((log) => `<article>
          <span>${icons.terminal}</span>
          <div><strong>${escapeHtml(log.type)} · ${escapeHtml(log.actor)}</strong><p>${escapeHtml(log.message)}</p><small>${formatTime(log.at)}</small></div>
        </article>`).join("") : polishedEmpty("No audit activity", "Actions will appear here as users and staff work in the archive.", icons.terminal)}
      </div>
    </section>`;
  }
  if (state.adminView === "search-admin") {
    const query = state.adminSearch.trim().toLowerCase();
    const allItems = [...archiveProjects(), ...archiveMaterials(), ...appData.uploads];
    const results = query ? allItems.filter((item) => JSON.stringify(item).toLowerCase().includes(query)) : allItems;
    return `<section class="admin-screen">
      <div class="admin-screen-head"><div><h2>Archive Query</h2><p>Search every project, material, upload, and review record.</p></div><span>${results.length} matches</span></div>
      <label class="admin-search-field">${icons.search}<input name="adminSearch" data-admin-search placeholder="Search ARE archive records..." value="${escapeHtml(state.adminSearch)}" /></label>
      <div class="admin-table">${results.map(adminArchiveRow).join("")}</div>
    </section>`;
  }
  if (state.adminView === "expand-log") {
    return `<div class="admin-info"><h2>Activity Log</h2><p>The terminal is live. User signups, sign-ins, uploads, approvals, and admin commands are written here.</p></div>`;
  }
  return "";
}

function reviewRow(item) {
  const resourceType = item.kind === "Material" ? "material" : "project";
  return `<article class="admin-row">
    <span>${item.kind === "Material" ? icons.book : icons.file}</span>
    <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.uploader || "Admin")} &middot; ${escapeHtml(item.fileName || "Metadata pending")} &middot; ${statusPill(item.status || "Pending Review")} &middot; ${formatTime(item.at)}</small></div>
    <div class="row-actions">
      <button data-admin-command="approve-review" data-review-id="${escapeHtml(item.id)}" data-review-type="${resourceType}">Approve</button>
      <button data-admin-command="reject-review" data-review-id="${escapeHtml(item.id)}" data-review-type="${resourceType}">Reject</button>
    </div>
  </article>`;
}

function adminUserRow(user) {
  const role = roleKey(user);
  const status = String(user.status || "Active").toLowerCase();
  const canPromote = isSuperAdmin() && ["staff", "hod"].includes(role) && status === "active";
  const needsApproval = isSuperAdmin() && ["staff", "hod"].includes(role) && status === "pending";
  const canDemote = isSuperAdmin() && role === "admin";
  const canToggleStatus = role !== "super_admin";
  const roleAction = canPromote
    ? `<button data-admin-command="promote-admin" data-user-id="${escapeHtml(user.id)}">Promote Admin</button>`
    : canDemote
      ? `<button data-admin-command="demote-admin" data-user-id="${escapeHtml(user.id)}">Demote Staff</button>`
      : needsApproval
        ? `<button disabled title="Approve staff before promotion">Approve first</button>`
        : "";
  return `<article class="admin-row">
    <span>${initials(user.name)}</span>
    <div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.role)} &middot; ${escapeHtml(user.status || "Active")} &middot; ${escapeHtml(user.email)}</small></div>
    <div class="row-actions">
      ${roleAction}
      ${canToggleStatus ? `<button data-admin-command="toggle-user" data-user-id="${escapeHtml(user.id)}">${user.status === "Suspended" ? "Restore" : "Suspend"}</button>` : ""}
    </div>
  </article>`;
}

function adminUserSummaryRow(user) {
  return `<article class="admin-row">
    <span>${initials(user.name)}</span>
    <div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.role)} &middot; ${escapeHtml(user.status || "Active")} &middot; ${escapeHtml(user.email)}</small></div>
  </article>`;
}

function adminAccessRow(user) {
  const role = roleKey(user);
  const status = String(user.status || "Active").toLowerCase();
  const canPromote = isSuperAdmin() && ["staff", "hod"].includes(role) && status === "active";
  const needsApproval = isSuperAdmin() && ["staff", "hod"].includes(role) && status === "pending";
  const canDemote = isSuperAdmin() && role === "admin";
  const canToggleStatus = role !== "super_admin";
  const roleAction = canPromote
    ? `<button data-admin-command="promote-admin" data-user-id="${escapeHtml(user.id)}">Promote Admin</button>`
    : canDemote
      ? `<button data-admin-command="demote-admin" data-user-id="${escapeHtml(user.id)}">Demote Staff</button>`
      : needsApproval
        ? `<button disabled title="Approve staff before promotion">Approve first</button>`
        : "";
  return `<article class="admin-row">
    <span>${icons.shield}</span>
    <div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.role)} &middot; ${escapeHtml(user.status || "Active")} &middot; ${escapeHtml(user.email)}</small></div>
    <div class="row-actions">
      ${roleAction}
      ${canToggleStatus ? `<button data-admin-command="toggle-user" data-user-id="${escapeHtml(user.id)}">${user.status === "Suspended" ? "Restore" : "Suspend"}</button>` : ""}
    </div>
  </article>`;
}

function pendingStaffReviewRow(user) {
  const requestedTitle = user.title || "Lecturer";
  const pendingId = user.staffId || "Pending ID";
  return `<article class="admin-row staff-review-row">
    <span>${icons.shield}</span>
    <div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(requestedTitle)} &middot; ${escapeHtml(user.staffEmail || user.email)} &middot; ${escapeHtml(pendingId)}</small></div>
    <div class="row-actions">
      <button data-admin-command="approve-staff-access" data-user-id="${escapeHtml(user.id)}">Approve + Generate ID</button>
      <button data-admin-command="toggle-user" data-user-id="${escapeHtml(user.id)}">Suspend</button>
    </div>
  </article>`;
}

function staffIdRow(staffId) {
  return `<article class="admin-row">
    <span>${icons.staff}</span>
    <div><strong>${escapeHtml(staffId.code)}</strong><small>${escapeHtml(staffId.name)} &middot; ${escapeHtml(staffId.status)}</small></div>
    <button data-admin-command="assign-staff-id" data-staff-id="${escapeHtml(staffId.id)}">${staffId.status === "Available" ? "Assign" : "View"}</button>
  </article>`;
}

function adminArchiveRow(item) {
  return `<article class="admin-row">
    <span>${item.kind === "Material" || item.code ? icons.book : icons.file}</span>
    <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.kind || item.type || item.code || "Archive Record")} &middot; ${escapeHtml(item.status || item.year || "Live")}</small></div>
  </article>`;
}

function formatTime(value) {
  if (!value) return "now";
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function dashStat(value, label, icon) {
  return `<article>${icon}<strong>${value}</strong><span>${label}</span></article>`;
}

function quickCard(title, desc, icon, route) {
  return `<button class="quick-card" data-route="${route}"><span>${icon}</span><strong>${title}</strong><p>${desc}</p></button>`;
}

function resourceContent() {
  if (state.route === "projects") {
    return `<h2>Projects</h2><div class="resource-grid">${projects.map((item) => `<article><span>${item.type}</span><h3>${item.title}</h3><p>${item.meta}</p><small>${item.year}</small></article>`).join("")}</div>`;
  }
  if (state.route === "materials") {
    return `<h2>Materials</h2><div class="resource-grid">${materials.map((item) => `<article><span>${item.code}</span><h3>${item.title}</h3><p>${item.type}</p><small>${item.level}</small></article>`).join("")}</div>`;
  }
  if (state.route === "search") {
    const query = state.search.trim().toLowerCase();
    const results = [...projects, ...materials].filter((item) => JSON.stringify(item).toLowerCase().includes(query));
    return `<h2>Search Results</h2><div class="resource-grid">${(query ? results : [...projects, ...materials]).map((item) => `<article><span>${item.type || item.code}</span><h3>${item.title}</h3><p>${item.meta || item.type}</p><small>${item.year || "Material"}</small></article>`).join("")}</div>`;
  }
  return "";
}

function footer() {
  return `<footer class="footer"><div class="container"><div><img src="./images/nexa-logo.png" alt="Nexaa" /><span>Academic Archive &amp; Resource System</span></div><p>${CREDIT_LINE}</p></div></footer>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function stableJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "";
  }
}

function initSplitTextAnimation() {
  const splitTarget = document.querySelector(".split-text");
  const mobileOrReducedMotion = window.matchMedia("(max-width: 720px), (prefers-reduced-motion: reduce)").matches;
  if (!splitTarget || mobileOrReducedMotion) return;

  if (splitTarget.dataset.splitAnimated === "true") return;
  splitTarget.dataset.splitAnimated = "true";
  splitTarget.classList.add("split-text-ready");
}

function commit(html, options = {}) {
  const quietRender = !state.appBooting && !state.pageLoading && !options.animated && !state.authFlipClass;
  const rootStepMotion = state.rootStepMotion;
  const nextMarkup = `${html}${appLoader()}`;
  document.body.classList.toggle("quiet-render", quietRender);
  document.body.classList.toggle("auth-panel-render", Boolean(options.panelOnly));
  if (nextMarkup === lastCommittedMarkup && !options.force) {
    if (quietRender) {
      window.setTimeout(() => document.body.classList.remove("quiet-render"), 180);
    }
    if (options.panelOnly) {
      window.setTimeout(() => document.body.classList.remove("auth-panel-render"), 180);
    }
    return;
  }
  root.innerHTML = nextMarkup;
  lastCommittedMarkup = nextMarkup;
  requestAnimationFrame(mountGoogleButton);
  requestAnimationFrame(mountRecaptcha);
  requestAnimationFrame(applyZoomLock);
  requestAnimationFrame(initSplitTextAnimation);
  requestAnimationFrame(blankPrivateVisibleFields);
  requestAnimationFrame(scheduleAuthErrorAutoClear);
  if (state.route === "login") requestAnimationFrame(() => updateAuthBannerDom({ preserveCycle: true }));
  if (quietRender) {
    window.setTimeout(() => document.body.classList.remove("quiet-render"), 180);
  }
  if (options.panelOnly) {
    window.setTimeout(() => document.body.classList.remove("auth-panel-render"), 180);
  }
  if (state.route === "root" && rootStepMotion) {
    window.setTimeout(() => {
      if (state.route === "root" && state.rootStepMotion === rootStepMotion) {
        state.rootStepMotion = "";
      }
    }, 720);
  }
  window.setTimeout(blankPrivateVisibleFields, 60);
  window.setTimeout(blankPrivateVisibleFields, 220);
  if (state.session?.access_token && !profileRefreshRequested) {
    profileRefreshRequested = true;
    requestAnimationFrame(async () => {
      const refreshed = await refreshBackendProfile();
      if (refreshed && state.user) render();
    });
  }
}

function appLoader() {
  if (!state.appBooting && !state.pageLoading) return "";
  return `
    <div class="app-loader ${state.appBooting ? "booting" : "transitioning"}" role="status" aria-live="polite">
      <div class="app-loader-card">
        <div class="app-loader-mark" aria-hidden="true">
          <span></span>
          <i></i>
        </div>
        <strong>Nexaa</strong>
        <p>${escapeHtml(state.loaderMessage || "Loading")}</p>
      </div>
    </div>
  `;
}

function blankPrivateVisibleFields() {
  if (state.route === "login" && state.authStep === "credentials" && !state.email && !state.password) {
    document.querySelectorAll("[data-auth-form] input[name='username'], [data-auth-form] input[name='current-password']").forEach((input) => {
      input.value = "";
    });
  }
  if (state.route === "login" && state.authStep === "profile" && state.profileRole === "staff") {
    const staffFields = [
      ["staffReviewContact", state.staffEmail],
      ["staffVerificationPhrase", state.staffId],
    ];
    staffFields.forEach(([name, value]) => {
      const input = document.querySelector(`[data-profile-form] input[name="${name}"]`);
      if (input && !value) input.value = "";
    });
  }
}

function maintenanceScreen() {
  return `<main class="maintenance-screen">
    <section class="maintenance-card">
      <span>${icons.spark}</span>
      <h1>Maintenance in progress</h1>
      <p>${escapeHtml(adminSettings.maintenanceMessage || defaultAdminSettings.maintenanceMessage)}</p>
      <small>Nexaa will be back once the administrator reopens access.</small>
    </section>
  </main>`;
}

function enforceRootBoundary() {
  if (!isRootUserRecord(state.user)) return false;
  if (currentPathIsRoot() && rootSessionActive()) return false;
  clearRootSession();
  removeSupabaseChannels();
  state.user = null;
  state.session = null;
  state.liveAdmin = { loaded: false, loading: false, error: "", stats: null, users: [], staffIds: [], uploads: [], notifications: [], rootSettings: null };
  state.liveArchive = { loaded: false, loading: false, error: "", projects: [], materials: [], savedIds: [], notifications: [] };
  localStorage.removeItem("nexaa-user");
  sessionStorage.removeItem("nexaa-session");
  if (["admin", "sentinel", "settings", "dashboard"].includes(state.route)) state.route = currentPathIsRoot() ? "root" : "home";
  return true;
}

function applyZoomLock() {
  root.classList.remove("zoom-locked");
  document.body.classList.remove("zoom-locked");
  document.documentElement.style.removeProperty("--app-lock-scale");
  document.documentElement.style.removeProperty("--app-lock-width");
  document.documentElement.style.removeProperty("--app-lock-min-height");
  document.documentElement.style.removeProperty("--app-lock-body-height");
}

function preventBrowserZoom(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  const key = String(event.key || "").toLowerCase();
  if (event.type === "wheel" || ["+", "-", "=", "0"].includes(key)) {
    event.preventDefault();
  }
}

function render(options = {}) {
  // Central router: turns state.route and auth status into the next screen.
  enforceRootBoundary();
  const route = state.route;
  const authRoutes = ["login", "admin-login"];
  appData = readData();
  updateMeta(route);
  document.body.classList.toggle("auth-lock", authRoutes.includes(route) || (["dashboard", "projects", "materials", "search", "saved", "settings", "upload", "lecturer"].includes(route) && !state.user));
  document.body.classList.toggle("super-admin-mode", Boolean(isSuperAdmin() && (route === "admin" || route === "sentinel" || route === "settings")));
  document.body.classList.toggle("menu-open", Boolean(state.menuOpen));
  document.body.classList.toggle("notification-lock", Boolean(state.notificationOpen));
  document.body.classList.toggle("protected-viewer-lock", Boolean(state.protectedViewerId));
  const protectedRoutes = ["dashboard", "projects", "materials", "search", "saved", "settings", "upload", "lecturer"];
  const staffRoutes = ["upload", "lecturer"];
  if (adminSettings.maintenanceEnabled && route !== "admin-login" && !isSuperAdmin()) {
    document.body.classList.add("auth-lock");
    commit(maintenanceScreen(), options);
    return;
  }
  if (route === "root") {
    document.body.classList.add("auth-lock");
    commit(rootLogin(), options);
    return;
  }
  if (route === "admin-login") {
    commit(adminLogin(), options);
    return;
  }
  if (route === "admin") {
    if (!state.user || !state.session?.access_token || !hasAdminAccess()) {
      state.route = "login";
      state.authMode = "login";
      updateMeta("login");
      if (window.location.hash !== "#login") {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#login`);
      }
      commit(authFlow(), options);
      return;
    }
    scheduleAdminOverviewLoad();
    if (state.adminView === "messages") scheduleSupportInboxLoad();
    if (state.adminView === "audit-log") scheduleSecurityCenterLoad();
    commit(adminDashboard(), options);
    return;
  }
  if (route === "sentinel") {
    if (!state.user) {
      state.route = "login";
      state.authMode = "login";
      updateMeta("login");
      if (window.location.hash !== "#login") {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#login`);
      }
      commit(authFlow(), options);
      return;
    }
    if (!isSuperAdmin()) {
      state.route = hasAdminAccess() ? "admin" : "dashboard";
      commit(hasAdminAccess() ? adminDashboard() : dashboard(), options);
      return;
    }
    scheduleSecurityCenterLoad();
    commit(sentinelPage(), options);
    return;
  }
  if (route === "settings" && state.user && hasAdminAccess()) {
    commit(shell(settingsScreen(), { admin: true }), options);
    return;
  }
  if (protectedRoutes.includes(route) && !state.user) {
    state.route = "login";
    state.authMode = "login";
    updateMeta("login");
    if (window.location.hash !== "#login") {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#login`);
    }
    commit(authFlow(), options);
    return;
  }
  if (staffRoutes.includes(route) && state.user && !hasStaffWorkspaceAccess()) {
    state.route = hasAdminAccess() ? "admin" : "dashboard";
    commit(hasAdminAccess() ? adminDashboard() : dashboard(), options);
    return;
  }
  if (protectedRoutes.includes(route) && state.user) {
    scheduleStudentArchiveLoad();
    scheduleStaffWorkspaceLoad();
    commit(dashboard(), options);
    return;
  }
  if (route === "login") {
    commit(authFlow(), options);
    return;
  }
  commit(landing(), options);
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

document.addEventListener("click", async (event) => {
  // Event delegation keeps dynamically rendered buttons interactive after every render().
  const routeTarget = event.target.closest("[data-route]");
  if (routeTarget) {
    navigate(routeTarget.dataset.route);
    return;
  }

  const modeTarget = event.target.closest("[data-mode]");
  if (modeTarget) {
    event.preventDefault();
    if (state.authMode === modeTarget.dataset.mode) return;
    clearAuthDraftFields();
    state.authMode = modeTarget.dataset.mode;
    state.authStep = "credentials";
    state.authFlipClass = state.authMode === "signup" ? "active" : "close";
    state.authError = "";
    if (!renderAuthPanelOnly()) render({ animated: true, panelOnly: true });
    window.setTimeout(() => {
      state.authFlipClass = "";
      document.querySelector(".auth-panel")?.classList.remove("auth-flip-active", "auth-flip-close");
    }, 680);
    return;
  }

  const bannerTarget = event.target.closest("[data-banner]");
  if (bannerTarget) {
    setBannerIndex(Number(bannerTarget.dataset.banner), { resetCycle: true, updateDom: true });
    return;
  }

  const categoryTarget = event.target.closest("[data-work-category]");
  if (categoryTarget) {
    state.workCategory = categoryTarget.dataset.workCategory;
    render();
    return;
  }

  const levelTarget = event.target.closest("[data-material-level]");
  if (levelTarget) {
    state.materialLevel = levelTarget.dataset.materialLevel;
    state.materialCourseCode = "";
    render();
    scrollMaterialStage("codes");
    return;
  }

  const materialTypeTarget = event.target.closest("[data-material-type]");
  if (materialTypeTarget) {
    state.materialType = materialTypeTarget.dataset.materialType;
    state.materialLevel = "";
    state.materialCourseCode = "";
    render();
    scrollMaterialStage("levels");
    return;
  }

  const materialCodeTarget = event.target.closest("[data-material-code]");
  if (materialCodeTarget) {
    state.materialCourseCode = materialCodeTarget.dataset.materialCode;
    render();
    scrollMaterialStage("results");
    return;
  }

  const viewTarget = event.target.closest("[data-view-mode]");
  if (viewTarget) {
    state.viewMode = viewTarget.dataset.viewMode;
    render();
    return;
  }

  const uploadModeTarget = event.target.closest("[data-upload-mode]");
  if (uploadModeTarget) {
    state.uploadMode = uploadModeTarget.dataset.uploadMode;
    if (state.uploadMode === "material") state.uploadMaterialType = uploadModeTarget.dataset.uploadMaterialType || state.uploadMaterialType || "PDF";
    if (state.uploadMode === "project") state.uploadMaterialType = "";
    state.uploadFile = null;
    state.uploadError = "";
    state.uploadNotice = "";
    render();
    return;
  }

  const typeTarget = event.target.closest("[data-type-filter]");
  if (typeTarget) {
    const filters = ["All Types", "Projects", "Materials"];
    state.contentType = filters[(filters.indexOf(state.contentType) + 1) % filters.length];
    render();
    return;
  }

  const searchFilterTarget = event.target.closest("[data-search-filter]");
  if (searchFilterTarget) {
    const options = String(searchFilterTarget.dataset.options || "").split("|").filter(Boolean);
    const key = searchFilterTarget.dataset.searchFilter;
    const stateKey = key === "year" ? "searchYear" : key === "level" ? "searchLevel" : "searchMaterialType";
    state[stateKey] = options[(options.indexOf(state[stateKey]) + 1) % options.length] || options[0] || state[stateKey];
    render();
    return;
  }

  const actionTarget = event.target.closest("[data-action]");
  const adminTarget = event.target.closest("[data-admin-command]");
  const adminTabTarget = event.target.closest("[data-admin-tab]");
  const staffTarget = event.target.closest("[data-staff-action]");
  const sentinelViewTarget = event.target.closest("[data-sentinel-view]");
  const sentinelModeTarget = event.target.closest("[data-sentinel-mode-target]");
  const sentinelLogTarget = event.target.closest("[data-sentinel-log]");
  const sentinelToastTarget = event.target.closest("[data-sentinel-toast]");
  const sentinelFilterTarget = event.target.closest("[data-sentinel-filter]");
  const sentinelAlertTarget = event.target.closest("[data-sentinel-alert-id]");
  const clickedNotificationLayer = event.target.closest(".notification-center, .notify-button");
  const hasSentinelTarget = Boolean(sentinelViewTarget || sentinelModeTarget || sentinelLogTarget || sentinelToastTarget || sentinelFilterTarget || sentinelAlertTarget);
  if (state.notificationOpen && !clickedNotificationLayer) {
    state.notificationOpen = false;
    if (!actionTarget && !adminTarget && !adminTabTarget && !staffTarget && !hasSentinelTarget) {
      render();
      return;
    }
  }
  if (adminTabTarget) {
    if (!hasAdminAccess() || !isAdminShellTarget(adminTabTarget)) {
      showStatusToast("Admin controls are isolated from lecturer workspace.", "Panel isolation", false);
      return;
    }
    state.adminPanelTab = adminTabTarget.dataset.adminTab || "users";
    state.adminView = "admin-panel";
    render();
    return;
  }
  if (hasSentinelTarget && (!hasAdminAccess() || !isAdminShellTarget(event.target))) {
    showStatusToast("That control only works inside the admin shell.", "Panel isolation", false);
    return;
  }
  if (sentinelViewTarget) {
    state.sentinelView = sentinelViewTarget.dataset.sentinelView || "overview";
    state.sentinelExpandedLog = "";
    addActivity("SECURITY", `Opened Sentinel ${state.sentinelView} module`, currentName());
    render();
    return;
  }
  if (sentinelModeTarget) {
    const nextMode = sentinelModeTarget.dataset.sentinelModeTarget || "normal";
    state.sentinelMode = nextMode;
    render();
    try {
      const data = await apiRequest("/api/security/status", {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({
          mode: nextMode.toUpperCase(),
          reason: nextMode === "lockdown" ? "Super Admin emergency restriction enabled from Sentinel." : nextMode === "maintenance" ? "Super Admin supervised maintenance enabled from Sentinel." : "",
        }),
      });
      state.liveSecurity.status = data.status || state.liveSecurity.status;
      state.sentinelMode = data.status?.modeSlug || nextMode;
      addActivity("SECURITY", `Sentinel mode changed to ${nextMode.toUpperCase()}`, currentName());
      showStatusToast(`${nextMode.toUpperCase()} mode applied.`, "Sentinel", nextMode !== "lockdown");
      scheduleSecurityCenterLoad(true);
      scheduleAdminOverviewLoad(true);
    } catch (error) {
      state.sentinelMode = state.liveSecurity.status?.modeSlug || "normal";
      showStatusToast(error?.message || "Sentinel mode update failed.", "Sentinel", false);
      render();
    }
    render();
    return;
  }
  if (sentinelLogTarget) {
    const id = sentinelLogTarget.dataset.sentinelLog || "";
    state.sentinelExpandedLog = state.sentinelExpandedLog === id ? "" : id;
    render();
    return;
  }
  if (sentinelToastTarget) {
    showStatusToast(sentinelToastTarget.dataset.sentinelToast || "Sentinel action staged.", "Sentinel", true);
    render();
    return;
  }
  if (sentinelFilterTarget) {
    sentinelFilterTarget.classList.toggle("active");
    showStatusToast("Audit filter staged.", "Sentinel", true);
    return;
  }
  if (sentinelAlertTarget) {
    const alertId = sentinelAlertTarget.dataset.sentinelAlertId || "";
    const status = sentinelAlertTarget.dataset.sentinelAlertStatus || "acknowledged";
    if (!alertId) {
      showStatusToast("This alert is not linked to a live database row yet.", "Sentinel", false);
      return;
    }
    try {
      const data = await apiRequest(`/api/security/alerts/${alertId}/status`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ status }),
      });
      state.liveSecurity.alerts = state.liveSecurity.alerts.map((alert) => alert.id === alertId ? data.alert : alert);
      showStatusToast(`Alert marked ${titleText(status)}.`, "Sentinel", true);
      scheduleSecurityCenterLoad(true);
    } catch (error) {
      showStatusToast(error?.message || "Could not update alert.", "Sentinel", false);
    }
    render();
    return;
  }
  if (adminTarget) {
    if (!hasAdminAccess() || !isAdminShellTarget(adminTarget)) {
      showStatusToast("Admin controls are isolated from lecturer workspace.", "Panel isolation", false);
      return;
    }
    await handleAdminCommand(adminTarget.dataset.adminCommand, adminTarget);
    return;
  }
  if (staffTarget) {
    if (!hasStaffWorkspaceAccess() || !isLecturerShellTarget(staffTarget)) {
      showStatusToast("Lecturer controls are isolated from admin workspace.", "Panel isolation", false);
      return;
    }
    await handleStaffAction(staffTarget.dataset.staffAction, staffTarget.dataset.staffId, staffTarget);
    return;
  }
  if (!actionTarget) return;
  if (actionTarget.dataset.action === "toggleMenu") {
    const nextMenuOpen = !state.menuOpen;
    state.menuOpen = nextMenuOpen;
    if (nextMenuOpen) state.notificationOpen = false;
    render();
    return;
  }
  if (actionTarget.dataset.action === "toggleNotifications") {
    const nextNotificationOpen = !state.notificationOpen;
    state.notificationOpen = nextNotificationOpen;
    if (nextNotificationOpen) state.menuOpen = false;
    render();
    return;
  }
  if (actionTarget.dataset.action === "refreshNotifications") {
    actionTarget.classList.add("is-refreshing");
    actionTarget.setAttribute("aria-busy", "true");
    await refreshNotifications();
    actionTarget.classList.remove("is-refreshing");
    actionTarget.removeAttribute("aria-busy");
    return;
  }
  if (actionTarget.dataset.action === "changeMaterialLevel") {
    state.materialLevel = "";
    state.materialCourseCode = "";
    render();
    scrollMaterialStage("levels");
    return;
  }
  if (actionTarget.dataset.action === "changeMaterialType") {
    state.materialType = "";
    state.materialLevel = "";
    state.materialCourseCode = "";
    render();
    scrollMaterialStage("types");
    return;
  }
  if (actionTarget.dataset.action === "restartTour") {
    localStorage.removeItem(userTourKey());
    state.tourActive = true;
    state.tourStep = 0;
    render();
    window.setTimeout(scrollTourFocusIntoView, 80);
    return;
  }
  if (actionTarget.dataset.action === "toggleHelp") {
    state.helpOpen = !state.helpOpen;
    if (state.helpOpen) state.helpSent = false;
    render();
    return;
  }
  if (actionTarget.dataset.action === "helpLogin" || actionTarget.dataset.action === "helpSignup") {
    state.authMode = actionTarget.dataset.action === "helpSignup" ? "signup" : "login";
    state.authStep = "credentials";
    state.authError = "";
    state.authNotice = "";
    state.helpOpen = false;
    navigate("login");
    return;
  }
  if (actionTarget.dataset.action === "tourNext") {
    const steps = currentTourSteps();
    if (state.tourStep >= steps.length - 1) {
      state.tourActive = false;
      localStorage.setItem(userTourKey(), "true");
    } else {
      state.tourStep += 1;
    }
    render();
    window.setTimeout(scrollTourFocusIntoView, 80);
    return;
  }
  if (actionTarget.dataset.action === "tourSkip") {
    state.tourActive = false;
    localStorage.setItem(userTourKey(), "true");
    render();
    return;
  }
  if (actionTarget.dataset.action === "toggleSaveResource") {
    try {
      showBookmarkToast(await toggleSavedResourceById(actionTarget.dataset.resourceId || ""));
    } catch (error) {
      const removing = actionTarget.getAttribute("aria-pressed") === "true";
      showErrorToast("saved", removing ? "removeFailed" : "saveFailed", "Saved Library");
    }
    render();
    return;
  }
  if (actionTarget.dataset.action === "viewProtectedWork") {
    const item = resourceById(actionTarget.dataset.resourceId || "");
    if (item) {
      state.protectedViewerId = resourceId(item);
      state.protectedViewerPage = 1;
      state.protectedViewerDocument = null;
      state.protectedViewerError = "";
      showStatusToast("Protected viewer opened.", item.title, true);
      loadProtectedViewerDocument(item);
    }
    render();
    requestAnimationFrame(() => document.querySelector(".protected-viewer-panel")?.focus());
    return;
  }
  if (actionTarget.dataset.action === "closeProtectedViewer") {
    state.protectedViewerId = "";
    state.protectedViewerDocument = null;
    state.protectedViewerError = "";
    state.protectedViewerLoading = false;
    state.protectedViewerPageLoading = false;
    clearProtectedPageImage();
    render();
    return;
  }
  if (actionTarget.dataset.action === "protectedPrevPage" || actionTarget.dataset.action === "protectedNextPage") {
    const pageCount = Math.max(1, Number(state.protectedViewerDocument?.pageCount || 1));
    state.protectedViewerPage += actionTarget.dataset.action === "protectedNextPage" ? 1 : -1;
    state.protectedViewerPage = Math.min(Math.max(1, state.protectedViewerPage), pageCount);
    loadProtectedViewerPage();
    render();
    return;
  }
  if (actionTarget.dataset.action === "downloadAbstract") {
    const item = resourceById(actionTarget.dataset.resourceId || "");
    if (item) {
      const abstractText = `${item.title}\n\n${item.abstract || item.meta || "Abstract unavailable."}`;
      const blob = new Blob([abstractText], { type: "text/plain;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${String(item.title || "abstract").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-abstract.txt`;
      document.body.appendChild(link);
      link.click();
      URL.revokeObjectURL(link.href);
      link.remove();
      showStatusToast("Abstract downloaded.", item.title, true);
    }
    render();
    return;
  }
  if (actionTarget.dataset.action === "openProjectUpload" || actionTarget.dataset.action === "openMaterialUpload") {
    state.uploadMode = actionTarget.dataset.action === "openMaterialUpload" ? "material" : "project";
    state.uploadMaterialType = state.uploadMode === "material" ? "PDF" : "";
    state.uploadFile = null;
    state.uploadError = "";
    state.uploadNotice = "";
    navigate("upload");
    return;
  }
  if (actionTarget.dataset.action === "togglePassword") {
    const fieldWrap = actionTarget.closest(".password-wrap, .root-password-field");
    const passwordInput = fieldWrap?.querySelector("input") || document.querySelector("[data-auth-password]");
    if (passwordInput?.matches("[data-auth-password]")) state.password = passwordInput.value;
    state.showPassword = !state.showPassword;
    if (passwordInput) passwordInput.type = state.showPassword ? "text" : "password";
    actionTarget.innerHTML = state.showPassword ? icons.eyeOff : icons.eye;
    actionTarget.setAttribute("aria-label", state.showPassword ? "Hide password" : "Show password");
    return;
  }
  if (actionTarget.dataset.action === "selectStudent") {
    state.profileRole = "student";
    state.isStaff = false;
    state.googlePendingProfile = null;
    state.staffFullName = "";
    state.staffEmail = "";
    state.staffId = "";
    state.staffTitle = "";
    state.adminScope = "";
    state.authError = "";
    render();
    return;
  }
  if (actionTarget.dataset.action === "selectStaff") {
    state.profileRole = "staff";
    state.isStaff = true;
    state.googlePendingProfile = null;
    state.staffFullName = "";
    state.staffEmail = "";
    state.staffId = "";
    state.staffTitle = "";
    state.adminScope = "";
    state.authError = "";
    render();
    return;
  }
  if (actionTarget.dataset.action === "continueRoleSetup") {
    state.authStep = "profile";
    state.authError = "";
    render();
    return;
  }
  if (actionTarget.dataset.action === "backToRole") {
    state.authStep = "role";
    state.authError = "";
    render();
    return;
  }
  if (actionTarget.dataset.action === "backToProfileSetup") {
    state.authStep = "profile";
    state.authError = "";
    render();
    return;
  }
  if (actionTarget.dataset.action === "backRootPassword") {
    state.rootAuthStep = "password";
    state.rootPassword = "";
    state.rootSecretPhrase = "";
    state.rootStepMotion = "back";
    state.authError = "";
    render();
    return;
  }
  if (actionTarget.dataset.action === "backToSignup") {
    state.authStep = "credentials";
    state.authError = "";
    state.signupOtpInput = "";
    render();
    return;
  }
  if (actionTarget.dataset.action === "resendSignupOtp") {
    await resendSignupOtp();
    return;
  }
  if (actionTarget.dataset.action === "gmailAuth") {
    continueWithGmail();
    return;
  }
  if (actionTarget.dataset.action === "rootLogin") {
    state.authMode = "login";
    state.authStep = "credentials";
    state.authError = "";
    state.rootEmail = "";
    navigate("login");
    return;
  }
  if (actionTarget.dataset.action === "changeProfile") {
    document.querySelector("[data-profile-input]")?.click();
    return;
  }
  if (actionTarget.dataset.action === "rootRecover") {
    const email = actionTarget.closest("form")?.querySelector('input[name="username"]')?.value || state.rootEmail;
    state.rootRecoverEmail = String(email || "").trim().toLowerCase();
    state.rootRecoverOpen = true;
    state.authError = "";
    render();
    return;
  }
  if (actionTarget.dataset.action === "closeRootRecover") {
    if (state.authSubmitting === "root-reset-link") return;
    state.rootRecoverOpen = false;
    state.authSubmitting = "";
    render();
    return;
  }
  if (actionTarget.dataset.action === "forgot") {
    state.resetOpen = true;
    state.resetEmail = state.email;
    resetModalState("otp");
    render();
    return;
  }
  if (actionTarget.dataset.action === "closeReset") {
    state.resetOpen = false;
    if (new URLSearchParams(window.location.search).has("reset_token")) {
      window.history.replaceState(null, "", `${window.location.pathname}#login`);
    }
    render();
    return;
  }
  if (actionTarget.dataset.action === "resendOtp") {
    if (state.authMode === "signup" && state.authStep === "verify-signup") {
      requestSignupOtp().then(() => render());
      return;
    }
    state.resetStep = "request";
    render();
    return;
  }
  if (actionTarget.dataset.action === "toggleProjectSort") {
    state.projectSort = state.projectSort === "newest" ? "oldest" : "newest";
    render();
    return;
  }
  if (actionTarget.dataset.action === "signOut") signOut();
  render();
});

document.addEventListener("focusin", (event) => {
  if (event.target.matches("[data-private-input]")) {
    event.target.removeAttribute("readonly");
  }
});

document.addEventListener("copy", (event) => {
  if (event.target.closest?.(".protected-work, .protected-viewer-layer")) {
    event.preventDefault();
    showStatusToast("Only abstracts can be copied for protected projects.", "Department policy", false);
    render();
  }
});

document.addEventListener("contextmenu", (event) => {
  if (event.target.closest?.(".protected-work, .protected-viewer-layer")) {
    event.preventDefault();
    showStatusToast("Full project files are protected from download or copy.", "Department policy", false);
    render();
  }
});

window.addEventListener("blur", () => {
  if (!state.protectedViewerId) return;
  document.body.classList.add("protected-viewer-obscured");
});

window.addEventListener("focus", () => {
  document.body.classList.remove("protected-viewer-obscured");
});

document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("protected-viewer-obscured", Boolean(state.protectedViewerId && document.hidden));
});

document.addEventListener("keydown", (event) => {
  if (!state.protectedViewerId) return;
  const key = String(event.key || "").toLowerCase();
  if (key === "escape") {
    state.protectedViewerId = "";
    state.protectedViewerDocument = null;
    state.protectedViewerError = "";
    state.protectedViewerLoading = false;
    state.protectedViewerPageLoading = false;
    clearProtectedPageImage();
    render();
    return;
  }
  if (key === "arrowright" || key === "arrowleft") {
    const pageCount = Math.max(1, Number(state.protectedViewerDocument?.pageCount || 1));
    state.protectedViewerPage += key === "arrowright" ? 1 : -1;
    state.protectedViewerPage = Math.min(Math.max(1, state.protectedViewerPage), pageCount);
    loadProtectedViewerPage();
    render();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && ["c", "s", "p", "a"].includes(key)) {
    event.preventDefault();
    showStatusToast("Full document actions are locked in protected view.", "Department policy", false);
    render();
  }
});

async function handleAdminCommand(command, target = null) {
  if ((command === "customize-admins" || command === "root-control" || command === "security-center" || command === "messages") && !isSuperAdmin()) {
    state.adminView = "admin-panel";
    addActivity("SECURITY", "Blocked non-super admin from root customization", currentName());
    render();
    return;
  }
  if (command === "security-center") {
    state.adminView = "security-center";
    navigate("sentinel");
    return;
  }
  if (command === "customize-admins") command = "root-control";
  state.adminView = command;
  if (command === "seed-user") {
    state.adminView = "admin-panel";
    showStatusToast("Students should register through the signup flow so auth credentials are created safely.", "User creation", false);
  } else if (command === "seed-staff") {
    state.adminView = "admin-panel";
    showStatusToast("Staff should request access through staff signup, then Super Admin/HOD can approve them.", "Staff creation", false);
  } else if (command === "approve-review") {
    const reviewId = target?.dataset.reviewId;
    const reviewType = target?.dataset.reviewType || "project";
    reviewId && await reviewUpload({ resourceId: reviewId, resourceType: reviewType, decision: "approved" });
    state.adminView = "reviews";
    addActivity("REVIEW", "Approved one pending review", currentName());
    scheduleAdminOverviewLoad(true);
  } else if (command === "reject-review") {
    const reviewId = target?.dataset.reviewId;
    const reviewType = target?.dataset.reviewType || "project";
    if (reviewId) {
      const comment = window.prompt("Add a clear reason for rejection:") || "";
      if (comment.trim().length < 4) {
        showStatusToast("A rejection comment is required.", "Review", false);
        render();
        return;
      }
      await reviewUpload({ resourceId: reviewId, resourceType: reviewType, decision: "rejected", comment });
    }
    state.adminView = "reviews";
    addActivity("REVIEW", "Rejected one pending review", currentName());
    scheduleAdminOverviewLoad(true);
  } else if (command === "issue-staff-id") {
    state.adminView = "admin-panel";
    showStatusToast("Staff IDs are generated automatically when pending staff are approved.", "Staff IDs", true);
  } else if (command === "assign-staff-id") {
    state.adminView = "admin-panel";
    showStatusToast("Staff ID assignment is tied to approval now.", "Staff IDs", true);
  } else if (command === "approve-staff-access") {
    const users = state.liveAdmin.loaded ? state.liveAdmin.users : appData.users;
    const user = users.find((item) => item.id === target?.dataset.userId);
    if (!user) {
      showStatusToast("No pending staff profile was selected.", "Staff access", false);
      state.adminView = "admin-panel";
      state.adminPanelTab = "staff-ids";
      render();
      return;
    }
    try {
      const response = await apiRequest(`/api/admin/profiles/${user.id}/status`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ status: "active" }),
      });
      const generatedId = response?.profile?.staffId || response?.profile?.staff_id || "";
      showStatusToast(generatedId ? `Staff approved. ID generated: ${generatedId}` : "Staff approved. ID generated automatically.", "Staff access", true);
      state.adminPanelTab = "staff-ids";
      scheduleAdminOverviewLoad(true);
      scheduleSecurityCenterLoad(true);
    } catch (error) {
      showStatusToast(error?.message || "Could not approve staff access.", "Staff access", false);
    }
    state.adminView = "admin-panel";
  } else if (command === "toggle-user") {
    const users = state.liveAdmin.loaded ? state.liveAdmin.users : appData.users;
    const user = users.find((item) => item.id === target?.dataset.userId);
    if (user) {
      const nextStatus = String(user.status || "").toLowerCase() === "suspended" ? "active" : "suspended";
      try {
        await apiRequest(`/api/admin/profiles/${user.id}/status`, {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ status: nextStatus }),
        });
        showStatusToast(nextStatus === "active" ? "User restored." : "User suspended.", "People", true);
        scheduleAdminOverviewLoad(true);
        scheduleSecurityCenterLoad(true);
      } catch (error) {
        showStatusToast(error?.message || "Could not update user status.", "People", false);
      }
    }
    state.adminView = "admin-panel";
  } else if (command === "promote-admin" || command === "demote-admin") {
    if (!isSuperAdmin()) {
      showStatusToast("Only Super Admin can change Admin roles.", "Role governance", false);
      state.adminView = "admin-panel";
      render();
      return;
    }
    const users = state.liveAdmin.loaded ? state.liveAdmin.users : appData.users;
    const user = users.find((item) => item.id === target?.dataset.userId);
    if (user) {
      const nextRole = command === "promote-admin" ? "admin" : "staff";
      try {
        await apiRequest(`/api/admin/profiles/${user.id}/role`, {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({
            role: nextRole,
            reason: command === "promote-admin" ? "Promoted from staff/lecturer by Super Admin" : "Demoted by Super Admin",
          }),
        });
        showStatusToast(nextRole === "admin" ? "Admin access granted." : "Admin access removed.", "Role governance", true);
        scheduleAdminOverviewLoad(true);
        scheduleSecurityCenterLoad(true);
      } catch (error) {
        showStatusToast(error?.message || "Could not update role.", "Role governance", false);
      }
    }
    state.adminView = "admin-panel";
  } else if (command === "refresh-messages") {
    state.adminView = "messages";
    scheduleSupportInboxLoad(true);
  } else {
    addActivity("CMD", `Opened ${command.replace("-", " ")} section`, currentName());
  }
  render();
}

async function handleStaffAction(action, staffId, target = null) {
  if (action === "approve-upload" || action === "reject-upload") {
    const reviewId = target?.dataset.reviewId || "";
    const reviewType = target?.dataset.reviewType || "project";
    if (!reviewId) {
      showStatusToast("No upload was selected.", "Review", false);
      return;
    }
    let comment = "";
    if (action === "reject-upload") {
      comment = window.prompt("Add a clear reason for rejection:") || "";
      if (comment.trim().length < 4) {
        showStatusToast("A rejection comment is required.", "Review", false);
        return;
      }
    }
    await reviewUpload({
      resourceId: reviewId,
      resourceType: reviewType,
      decision: action === "approve-upload" ? "approved" : "rejected",
      comment,
    });
    await loadStaffWorkspace({ force: true });
    render();
    return;
  }
  const roster = staffRoster();
  const rosterTarget = action === "approve-next"
    ? roster.find((user) => isPendingStatus(user.status))
    : roster.find((user) => user.id === staffId);
  if (!rosterTarget || rosterTarget.id === "current-staff") {
    showStatusToast("No eligible staff request found.", "Staff access", false);
    return;
  }
  const nextStatus = action === "approve-next" || action === "approve-staff"
    ? "active"
    : String(rosterTarget.status || "").toLowerCase() === "suspended" ? "active" : "suspended";
  try {
    await apiRequest(`/api/admin/profiles/${rosterTarget.id}/status`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ status: nextStatus }),
    });
    showStatusToast(nextStatus === "active" ? "Staff access approved." : "Staff access suspended.", "Staff access", true);
    await loadStaffWorkspace({ force: true });
  } catch (error) {
    showStatusToast(error?.message || errorMessage("profile", "staffRequestFailed"), "Staff access", false);
  }
  render();
}

document.addEventListener("submit", async (event) => {
  // Forms call async backend actions here instead of attaching handlers during render.
  if (event.target.matches("[data-root-recover-form]")) {
    event.preventDefault();
    const form = new FormData(event.target);
    await requestRootPasswordReset(String(form.get("rootRecoverEmail") || state.rootRecoverEmail || state.rootEmail));
    return;
  }
  if (event.target.matches("[data-auth-form]")) return signInFromForm(event);
  if (event.target.matches("[data-signup-otp-form]")) return verifySignupOtp(event);
  if (event.target.matches("[data-profile-form]")) return completeProfileSetup(event);
  if (event.target.matches("[data-google-password-form]")) return completeGooglePasswordSetup(event);
  if (event.target.matches("[data-reset-form]")) return requestPasswordReset(event);
  if (event.target.matches("[data-new-password-form]")) return completePasswordReset(event);
  if (event.target.matches("[data-staff-upload]")) {
    event.preventDefault();
    if (!hasStaffWorkspaceAccess() || !isLecturerShellTarget(event.target)) {
      showStatusToast("Lecturer uploads must stay inside the lecturer workspace.", "Panel isolation", false);
      return;
    }
    const form = new FormData(event.target);
    const kind = event.target.dataset.staffUpload || "Project";
    const title = String(form.get("title") || form.get("courseTitle") || "Untitled resource");
    const file = state.uploadFile;
    const fileError = validateUploadFile(file);
    if (fileError) {
      state.uploadError = fileError;
      state.uploadNotice = "";
      render();
      return;
    }
    state.uploadSubmitting = true;
    state.uploadError = "";
    state.uploadNotice = "Uploading securely...";
    render();

    const metadata = kind === "Project"
      ? {
        category: state.workCategory,
        abstract: String(form.get("abstract") || ""),
        year: String(form.get("year") || new Date().getFullYear()),
        supervisor: String(form.get("supervisor") || ""),
        authors: String(form.get("authors") || ""),
        bookId: String(form.get("projectId") || ""),
        cabinet: String(form.get("cabinet") || form.get("location") || ""),
        row: String(form.get("row") || ""),
        column: String(form.get("column") || ""),
      }
      : {
        courseCode: String(form.get("courseCode") || "ARE"),
        courseTitle: String(form.get("courseTitle") || title),
        level: String(form.get("level") || state.materialLevel || "400L"),
        materialType: String(form.get("materialType") || state.uploadMaterialType || "PDF"),
        year: String(form.get("year") || new Date().getFullYear()),
      };

    try {
      await uploadProtectedFile({ file, title, kind, metadata });
    } catch (error) {
      state.uploadSubmitting = false;
      state.uploadError = errorMessage("uploads", "failed");
      state.uploadNotice = "";
      render();
      return;
    }

    addActivity("UPLOAD", `${kind} uploaded by staff`, currentName());
    state.uploadFile = null;
    state.uploadError = "";
    state.uploadSubmitting = false;
    state.uploadNotice = "Upload sent for review.";
    state.route = "lecturer";
    state.lecturerView = "overview";
    await loadStaffWorkspace({ force: true });
    render();
  }
  if (event.target.matches("[data-admin-upload]")) {
    event.preventDefault();
    if (!hasAdminAccess() || !isAdminShellTarget(event.target)) {
      showStatusToast("Admin uploads must stay inside the admin workspace.", "Panel isolation", false);
      return;
    }
    const form = new FormData(event.target);
    appData = readData();
    const kind = String(form.get("kind") || "Project");
    appData.uploads.unshift({
      id: crypto.randomUUID(),
      title: String(form.get("title") || "Untitled"),
      kind,
      uploader: currentName(),
      department: String(form.get("department") || DEPARTMENT_NAME),
      status: "Approved",
      fileName: String(form.get("fileName") || "archive-document.pdf"),
      fileSize: "Manual entry",
      at: new Date().toISOString(),
    });
    appData.pendingReviews = appData.uploads.filter((item) => item.status === "Pending Review").length;
    writeData(appData);
    addActivity("UPLOAD", `${kind} uploaded and published by admin`, currentName());
    state.adminView = "upload";
    render();
  }
  if (event.target.matches("[data-admin-customizer]")) {
    event.preventDefault();
    if (!hasAdminAccess() || !isAdminShellTarget(event.target)) {
      showStatusToast("Root settings must stay inside the admin workspace.", "Panel isolation", false);
      return;
    }
    if (!isSuperAdmin()) {
      addActivity("SECURITY", "Blocked non-super admin customization submit", currentName());
      render();
      return;
    }
    const form = new FormData(event.target);
    const nextNotifications = [...(adminSettings.notifications || [])];
    const notificationRole = String(form.get("notificationRole") || "");
    const notificationTitle = String(form.get("notificationTitle") || "").trim();
    const notificationBody = String(form.get("notificationBody") || "").trim();
    let createdNotification = null;
    if (notificationRole && notificationTitle && notificationBody) {
      createdNotification = {
        id: crypto.randomUUID(),
        targetRole: notificationRole,
        title: notificationTitle,
        body: notificationBody,
        at: new Date().toISOString(),
      };
      nextNotifications.unshift(createdNotification);
    }
    const rootSettingsPayload = {
      theme: String(form.get("theme") || defaultAdminSettings.theme),
      accent: String(form.get("accent") || defaultAdminSettings.accent),
      dashboardTitle: String(form.get("dashboardTitle") || defaultAdminSettings.dashboardTitle),
      welcomeText: String(form.get("welcomeText") || defaultAdminSettings.welcomeText),
      defaultAdminRole: String(form.get("defaultAdminRole") || defaultAdminSettings.defaultAdminRole),
      maintenanceEnabled: form.get("maintenanceEnabled") === "on",
      maintenanceMessage: String(form.get("maintenanceMessage") || defaultAdminSettings.maintenanceMessage),
    };
    writeAdminSettings({
      ...rootSettingsPayload,
      notifications: nextNotifications.slice(0, 40),
    });
    try {
      const response = await apiRequest("/api/admin/root-settings", {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(rootSettingsPayload),
      });
      if (response.rootSettings) {
        adminSettings = { ...adminSettings, ...response.rootSettings, notifications: nextNotifications.slice(0, 40) };
        localStorage.setItem(ADMIN_SETTINGS_KEY, JSON.stringify(adminSettings));
      }
      if (createdNotification) await pushNotificationToSupabase(createdNotification);
      addActivity("ADMIN", notificationRole ? `Sent message to ${notificationRole}` : "Updated Super Admin root settings", currentName());
      realtimeChannel?.postMessage({ type: "admin-settings:update", at: Date.now() });
      scheduleSupabaseRealtimeSetup();
      scheduleAdminOverviewLoad(true);
      scheduleSecurityCenterLoad(true);
      showStatusToast("Root settings saved live.", "Root", true);
    } catch (error) {
      showStatusToast(error?.message || "Could not save root settings.", "Root", false);
    }
    state.adminView = "root-control";
    render();
  }
  if (event.target.matches("[data-support-reply-form]")) {
    event.preventDefault();
    const form = new FormData(event.target);
    const supportRequestId = String(form.get("supportRequestId") || "");
    const payload = {
      supportRequestId,
      to: String(form.get("to") || ""),
      subject: String(form.get("subject") || ""),
      message: String(form.get("message") || ""),
    };
    if (!payload.to.trim() || !payload.subject.trim() || !payload.message.trim()) {
      showStatusToast("Complete the reply before sending.", "Messages", false);
      return;
    }
    state.liveSupport.replying = supportRequestId;
    render();
    try {
      await apiRequest("/api/support/reply", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      showStatusToast("Reply sent through Gmail.", "Messages", true);
      await loadSupportInbox({ force: true });
    } catch (error) {
      showStatusToast(error?.message || "Could not send reply.", "Messages", false);
    } finally {
      state.liveSupport.replying = "";
      render();
    }
  }
  if (event.target.matches("[data-help-form]")) {
    event.preventDefault();
    const form = new FormData(event.target);
    const supportRequest = {
      id: crypto.randomUUID(),
      name: String(form.get("supportDisplay") || currentName()),
      email: String(form.get("supportContact") || state.email || ""),
      adminEmail: SUPPORT_ADMIN_EMAIL,
      message: String(form.get("supportBody") || ""),
      status: "Open",
      at: new Date().toISOString(),
    };
    if (!supportRequest.name.trim() || !supportRequest.email.trim() || !supportRequest.message.trim()) {
      showErrorToast("support", "missingFields", "Need help");
      return;
    }
    try {
      const response = await apiRequest("/api/support", {
        method: "POST",
        body: JSON.stringify({
          name: supportRequest.name,
          email: supportRequest.email,
          message: supportRequest.message,
        }),
      });
      if (response.supportRequest?.id) {
        supportRequest.id = response.supportRequest.id;
        supportRequest.status = response.supportRequest.status || "Sent";
      }
      supportRequest.status = "Sent";
    } catch {
      showErrorToast("support", "sendFailed", "Need help");
      render();
      return;
    }
    appData = readData();
    appData.supportRequests.unshift(supportRequest);
    writeData(appData);
    state.helpSent = true;
    state.helpOpen = true;
    addActivity("SUPPORT", "New administrator contact request", String(form.get("supportDisplay") || currentName()));
    render();
  }
  if (event.target.matches("[data-action='search']")) {
    event.preventDefault();
    state.search = event.target.querySelector("input")?.value || "";
    if (!state.user) {
      state.authMode = "login";
      navigate("login");
    } else {
      navigate("search");
    }
  }
});

document.addEventListener("mouseover", (event) => {
  const bubble = event.target.closest(".help-bubble");
  if (!bubble) return;
  const widget = bubble.closest(".help-widget");
  if (!widget || widget.classList.contains("open")) return;
  widget.classList.add("peek");
});

document.addEventListener("mouseout", (event) => {
  const bubble = event.target.closest(".help-bubble");
  if (!bubble) return;
  const widget = bubble.closest(".help-widget");
  if (!widget) return;
  if (bubble.contains(event.relatedTarget)) return;
  widget.classList.remove("peek");
});

document.addEventListener("mousemove", (event) => {
  const hoveredBubble = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".help-bubble");
  document.querySelectorAll(".help-widget.peek").forEach((widget) => {
    if (!hoveredBubble || widget !== hoveredBubble.closest(".help-widget")) widget.classList.remove("peek");
  });
  const widget = hoveredBubble?.closest(".help-widget");
  if (widget && !widget.classList.contains("open")) widget.classList.add("peek");
});

document.addEventListener("input", (event) => {
  if (event.target.matches("[data-dashboard-search]")) {
    state.search = event.target.value;
    if (state.route !== "search") state.route = "search";
    render();
  }
  if (event.target.matches("[data-student-search]")) {
    const context = event.target.closest("[data-search-context]")?.dataset.searchContext;
    state.search = event.target.value;
    render();
    requestAnimationFrame(() => {
      const input = document.querySelector(`[data-search-context="${context}"] [data-student-search]`);
      if (!input) return;
      input.focus();
      input.setSelectionRange(state.search.length, state.search.length);
    });
  }
  if (event.target.matches("[data-admin-search]")) {
    state.adminSearch = event.target.value;
    render();
  }
  if (event.target.name === "username") {
    if (state.route === "root") state.rootEmail = event.target.value.toLowerCase();
    else state.email = event.target.value;
  }
  if (event.target.name === "current-password") state.password = event.target.value;
  if (event.target.name === "rootSecretPhrase") state.rootSecretPhrase = event.target.value;
  if (event.target.name === "signupOtp") state.signupOtpInput = event.target.value;
  if (event.target.name === "firstName") state.firstName = event.target.value;
  if (event.target.name === "lastName") state.lastName = event.target.value;
  if (event.target.name === "fullName") state.staffFullName = event.target.value;
  if (event.target.name === "staffId" || event.target.name === "staffVerificationPhrase") state.staffId = event.target.value.toUpperCase();
  if (event.target.name === "staffEmail" || event.target.name === "staffReviewContact") state.staffEmail = event.target.value.toLowerCase();
  if (event.target.name === "matricNumber") state.matricNumber = event.target.value.toUpperCase();
  if (event.target.name === "adminScope") state.adminScope = event.target.value;
  if (event.target.name === "level") state.studentLevel = event.target.value;
  if (event.target.name === "staffTitle") state.staffTitle = event.target.value;
  if (event.target.name === "resetEmail") state.resetEmail = event.target.value;
  if (event.target.name === "resetOtp") state.resetOtpInput = event.target.value;
  if (event.target.name === "newPassword") state.resetPassword = event.target.value;
  if (event.target.name === "confirmPassword") state.resetConfirm = event.target.value;
  if (event.target.name === "resetMethod") {
    state.resetMethod = event.target.value;
    render();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-profile-input]")) {
    saveProfilePicture(event.target.files?.[0]);
    event.target.value = "";
  }
  if (event.target.matches("[data-upload-file]")) {
    setUploadFile(event.target.files?.[0]);
  }
  if (event.target.name === "resetMethod") {
    state.resetMethod = event.target.value;
    render();
  }
});

document.addEventListener("dragover", (event) => {
  if (!event.target.closest("[data-drop-zone]")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  event.target.closest("[data-drop-zone]").classList.add("dragging");
});

document.addEventListener("dragleave", (event) => {
  const dropZone = event.target.closest("[data-drop-zone]");
  if (!dropZone || dropZone.contains(event.relatedTarget)) return;
  dropZone.classList.remove("dragging");
});

document.addEventListener("drop", (event) => {
  const dropZone = event.target.closest("[data-drop-zone]");
  if (!dropZone) return;
  event.preventDefault();
  dropZone.classList.remove("dragging");
  setUploadFile(event.dataTransfer.files?.[0]);
});

window.addEventListener("storage", (event) => {
  if (event.key === DATA_KEY || event.key === "nexaa-user" || event.key === ADMIN_SETTINGS_KEY || event.key === PROFILE_BUCKET_KEY) {
    appData = readData();
    adminSettings = readAdminSettings();
    const nextUser = readStoredUser();
    const changed = stableJson({ user: state.user, data: lastDataSignature }) !== stableJson({ user: nextUser, data: localStorage.getItem(DATA_KEY) || "" });
    state.user = nextUser;
    lastDataSignature = localStorage.getItem(DATA_KEY) || "";
    if (changed && ["admin", "lecturer", "upload", "dashboard", "projects", "materials", "search"].includes(state.route)) render();
  }
});

window.addEventListener("resize", applyZoomLock);
desktopZoomLock.addEventListener?.("change", applyZoomLock);
document.addEventListener("wheel", preventBrowserZoom, { passive: false });
document.addEventListener("keydown", preventBrowserZoom);
document.addEventListener("gesturestart", (event) => event.preventDefault());
window.addEventListener("nexaa:supabase-ready", () => {
  supabaseRealtimeUnavailable = false;
  scheduleSupabaseRealtimeSetup();
});

realtimeChannel?.addEventListener("message", () => {
  const previousSignature = lastDataSignature;
  appData = readData();
  lastDataSignature = localStorage.getItem(DATA_KEY) || "";
  if (previousSignature !== lastDataSignature && ["admin", "lecturer", "upload", "dashboard", "projects", "materials", "search"].includes(state.route)) render();
});

setInterval(() => {
  const nextSignature = localStorage.getItem(DATA_KEY) || "";
  if (nextSignature !== lastDataSignature) {
    lastDataSignature = nextSignature;
    appData = readData();
    if (["admin", "lecturer", "upload", "dashboard", "projects", "materials", "search"].includes(state.route)) render();
  }
}, 2500);

setInterval(() => {
  const bannerDotsVisible = Boolean(document.querySelector(".slide-dots"));
  const captchaVisible = Boolean(document.querySelector(".recaptcha-wrap iframe, .recaptcha-note"));
  const overlayVisible = Boolean(state.notificationOpen || document.querySelector(".notification-layer, .bookmark-toast, .auth-error"));
  if (state.route !== "login" || !bannerDotsVisible || state.appBooting || captchaVisible || overlayVisible) return;
  setBannerIndex(Number(state.bannerIndex || 0) + 1, { resetCycle: true, updateDom: true });
}, BANNER_CYCLE_MS);

render({ animated: true });
requestAnimationFrame(() => window.setTimeout(() => {
  state.appBooting = false;
  document.querySelector(".app-loader")?.remove();
}, 120));
scheduleSupabaseRealtimeSetup();
