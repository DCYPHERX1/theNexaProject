(() => {
// Shared browser config. Real Supabase values are injected by
// /js/runtime-config.js during local development, before this file runs.
const DATA_KEY = "nexaa-data";
const PROFILE_BUCKET_KEY = "nexaa-profile-pictures";
const ADMIN_SETTINGS_KEY = "nexaa-admin-dashboard-settings";
const TOUR_KEY = "nexaa-dashboard-tour-complete";
const DEPARTMENT_NAME = "Agricultural and Resource Economics";
const CREDIT_LINE = "Made by ARE Class '25 - The Agro Nexas";
const GOOGLE_CLIENT_ID_PLACEHOLDER = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
const SUPABASE_URL = window.NEXA_SUPABASE_URL || localStorage.getItem("nexa-supabase-url") || "";
const SUPABASE_PUBLISHABLE_KEY = window.NEXA_SUPABASE_PUBLISHABLE_KEY || localStorage.getItem("nexa-supabase-publishable-key") || "";
const allowedUploadExtensions = ["pdf", "doc", "docx", "ppt", "pptx"];
const maxUploadBytes = 50 * 1024 * 1024;

const defaultData = {
  users: [],
  activity: [],
  uploads: [],
  staffIds: [],
  supportRequests: [],
  pendingReviews: 0,
  institutions: [
    { id: "are-university", name: "ARE University Archive", type: "University", country: "Nigeria" },
  ],
  faculties: [
    { id: "agriculture", institutionId: "are-university", name: "Faculty of Agriculture" },
  ],
  departments: [
    { id: "are", facultyId: "agriculture", name: DEPARTMENT_NAME },
  ],
  programmes: [
    { id: "bsc-are", departmentId: "are", name: "B.Sc. Agricultural and Resource Economics", levels: ["100L", "200L", "300L", "400L", "500L"] },
  ],
};

const defaultAdminSettings = {
  theme: "Nexaa Classic",
  accent: "Gold",
  dashboardTitle: "Admin Control Center",
  welcomeText: "Manage users, reviews, staff IDs, uploads, and archive operations.",
  defaultAdminRole: "Admin",
  maintenanceEnabled: false,
  maintenanceMessage: "Maintenance in progress. Please check back shortly.",
  notifications: [],
};

const projects = [
];

const materials = [
];

window.NEXAA_CONFIG = {
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
};
})();
