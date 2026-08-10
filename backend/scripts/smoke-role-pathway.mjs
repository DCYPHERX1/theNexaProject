import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:5177";
const suffix = process.env.SMOKE_SUFFIX || `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
const password = `NexaaSmoke${suffix}!`;
const rootEmail = String(process.env.ROOT_SUPER_ADMIN_EMAIL || "admin.nexaa@gmail.com").toLowerCase();
const rootPassword = process.env.ROOT_SUPER_ADMIN_PASSWORD;
const rootSecret = process.env.ROOT_SUPER_ADMIN_SECRET_PHRASE || "dcypher";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase admin environment");
}
if (!rootPassword) {
  throw new Error("Missing ROOT_SUPER_ADMIN_PASSWORD");
}

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const results = [];
const createdUserIds = [];
const createdProtectedFileIds = [];
const createdStoragePaths = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  const label = pass ? "PASS" : "FAIL";
  console.log(`${label} ${name}${detail ? ` - ${detail}` : ""}`);
}

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

async function request(path, { token, method = "GET", body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = { text: await response.text().catch(() => "") };
  }
  return { response, payload };
}

async function findAuthUserByEmail(email) {
  const target = String(email).toLowerCase();
  let page = 1;
  while (page < 20) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((user) => String(user.email || "").toLowerCase() === target);
    if (found) return found;
    if (data.users.length < 1000) return null;
    page += 1;
  }
  return null;
}

async function recreateUser(email, userPayload, profilePayload) {
  const existing = await findAuthUserByEmail(email);
  if (existing) {
    await supabaseAdmin.auth.admin.deleteUser(existing.id);
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: userPayload.user_metadata,
    app_metadata: userPayload.app_metadata,
  });
  if (error) throw error;
  createdUserIds.push(data.user.id);

  const { error: profileError } = await supabaseAdmin.from("profiles").upsert({
    id: data.user.id,
    email,
    ...profilePayload,
    updated_at: new Date().toISOString(),
  });
  if (profileError) throw profileError;
  return data.user;
}

async function cleanup() {
  const { data: smokeFiles } = await supabaseAdmin
    .from("protected_files")
    .select("id,storage_path")
    .eq("title", "Nexaa Smoke Material");
  for (const file of smokeFiles || []) {
    if (!createdProtectedFileIds.includes(file.id)) createdProtectedFileIds.push(file.id);
    if (file.storage_path && !createdStoragePaths.includes(file.storage_path)) createdStoragePaths.push(file.storage_path);
  }
  for (const id of createdProtectedFileIds.reverse()) {
    await supabaseAdmin.from("academic_materials").delete().eq("protected_file_id", id);
    await supabaseAdmin.from("projects").delete().eq("protected_file_id", id);
    await supabaseAdmin.from("protected_files").delete().eq("id", id);
  }
  const uploadRoot = process.env.PROTECTED_UPLOAD_DIR || path.join(process.cwd(), "uploads", "protected");
  for (const storagePath of createdStoragePaths) {
    const target = path.resolve(uploadRoot, storagePath);
    if (target.startsWith(path.resolve(uploadRoot))) {
      fs.rmSync(target, { force: true });
    }
  }
  for (const id of createdUserIds.reverse()) {
    await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
  }
  let page = 1;
  while (page < 20) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data?.users?.length) break;
    for (const user of data.users) {
      const email = String(user.email || "").toLowerCase();
      if (email.startsWith("smoke.student.") || email.startsWith("smoke.staff.")) {
        await supabaseAdmin.auth.admin.deleteUser(user.id).catch(() => {});
      }
    }
    if (data.users.length < 1000) break;
    page += 1;
  }
}

try {
  const studentEmail = `smoke.student.${suffix}@example.com`;
  const staffEmail = `smoke.staff.${suffix}@example.com`;
  const staffFutaEmail = `smoke.staff.${suffix}@futa.edu.ng`;
  const pendingStaffId = `PENDING-SMOKE-${suffix}`.slice(0, 40);
  const matricNumber = `ARE/26/${suffix.slice(-4).toUpperCase()}`;

  const student = await recreateUser(
    studentEmail,
    {
      user_metadata: {
        name: "Smoke Student",
        full_name: "Smoke Student",
        role: "student",
        department: "Agricultural and Resource Economics",
        matric_number: matricNumber,
        level: "300L",
        status: "active",
      },
      app_metadata: { role: "student", status: "active" },
    },
    {
      full_name: "Smoke Student",
      role: "student",
      department: "Agricultural and Resource Economics",
      matric_number: matricNumber,
      level: "300L",
      status: "active",
    }
  );

  const staff = await recreateUser(
    staffEmail,
    {
      user_metadata: {
        name: "Smoke Lecturer",
        full_name: "Smoke Lecturer",
        role: "staff",
        department: "Agricultural and Resource Economics",
        staff_id: pendingStaffId,
        staff_email: staffFutaEmail,
        title: "Lecturer",
        status: "pending",
      },
      app_metadata: { role: "staff", status: "pending" },
    },
    {
      full_name: "Smoke Lecturer",
      role: "staff",
      department: "Agricultural and Resource Economics",
      staff_id: pendingStaffId,
      staff_email: staffFutaEmail,
      title: "Lecturer",
      status: "pending",
    }
  );

  record("temporary smoke accounts created", Boolean(student.id && staff.id), `${studentEmail}, ${staffEmail}`);

  const health = await request("/api/health");
  record("backend health is available", health.response.ok, health.payload.service || health.payload.error);

  const studentLogin = await request("/api/auth/login", { method: "POST", body: { email: studentEmail, password } });
  const studentToken = studentLogin.payload.session?.access_token;
  record("student can login", studentLogin.response.ok && Boolean(studentToken), studentLogin.payload.error || normalizeRole(studentLogin.payload.profile?.role));

  const studentAdmin = await request("/api/admin/overview", { token: studentToken });
  record("student cannot access admin overview", studentAdmin.response.status === 403, `${studentAdmin.response.status}`);

  const studentStaff = await request("/api/staff/dashboard", { token: studentToken });
  record("student cannot access lecturer dashboard", studentStaff.response.status === 403, `${studentStaff.response.status}`);

  const pendingLogin = await request("/api/auth/login", { method: "POST", body: { email: staffEmail, password } });
  const pendingToken = pendingLogin.payload.session?.access_token;
  record("pending staff can login but remains pending", pendingLogin.response.ok && normalizeRole(pendingLogin.payload.profile?.role) === "staff" && pendingLogin.payload.profile?.status === "pending", pendingLogin.payload.error || pendingLogin.payload.profile?.status);

  const pendingDashboard = await request("/api/staff/dashboard", { token: pendingToken });
  record("pending staff cannot access lecturer tools", pendingDashboard.response.status === 403, `${pendingDashboard.response.status}`);

  const rootLogin = await request("/api/auth/root-login", {
    method: "POST",
    body: { email: rootEmail, password: rootPassword, secretPhrase: rootSecret },
  });
  const rootToken = rootLogin.payload.session?.access_token;
  record("super admin root login works", rootLogin.response.ok && Boolean(rootToken) && normalizeRole(rootLogin.payload.profile?.role) === "super_admin", rootLogin.payload.error || normalizeRole(rootLogin.payload.profile?.role));

  const earlyPromote = await request(`/api/admin/profiles/${staff.id}/role`, {
    token: rootToken,
    method: "PATCH",
    body: { role: "admin" },
  });
  record("pending staff cannot be promoted before approval", earlyPromote.response.status === 400, `${earlyPromote.response.status}`);

  const approve = await request(`/api/admin/profiles/${staff.id}/status`, {
    token: rootToken,
    method: "PATCH",
    body: { status: "active" },
  });
  record("super admin can approve staff", approve.response.ok && approve.payload.profile?.status === "active", approve.payload.error || approve.payload.profile?.staffId || approve.payload.profile?.staff_id);

  const activeLogin = await request("/api/auth/login", { method: "POST", body: { email: staffEmail, password } });
  const activeToken = activeLogin.payload.session?.access_token;
  record("approved lecturer can login active", activeLogin.response.ok && activeLogin.payload.profile?.status === "active", activeLogin.payload.error || activeLogin.payload.profile?.status);

  const lecturerDashboard = await request("/api/staff/dashboard", { token: activeToken });
  record("approved lecturer can access lecturer dashboard", lecturerDashboard.response.ok, `${lecturerDashboard.response.status}`);

  const lecturerSentinel = await request("/api/security/status", { token: activeToken });
  record("lecturer cannot access Sentinel", lecturerSentinel.response.status === 403, `${lecturerSentinel.response.status}`);

  const uploadForm = new FormData();
  uploadForm.set("file", new Blob([Buffer.from("%PDF-1.4\n% Nexaa smoke\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")], { type: "application/pdf" }), "nexaa-smoke.pdf");
  uploadForm.set("kind", "Material");
  uploadForm.set("title", "Nexaa Smoke Material");
  uploadForm.set("courseCode", "ARE 999");
  uploadForm.set("courseTitle", "Smoke Testing");
  uploadForm.set("level", "400L");
  uploadForm.set("materialType", "lecture_note");
  uploadForm.set("year", "2026");
  const upload = await request("/api/files", { token: activeToken, method: "POST", form: uploadForm });
  if (upload.payload?.id) createdProtectedFileIds.push(upload.payload.id);
  if (upload.payload?.storage_path) createdStoragePaths.push(upload.payload.storage_path);
  record("approved lecturer can upload", upload.response.status === 201, upload.payload.error || upload.payload.archiveRecord?.type || `${upload.response.status}`);

  const promote = await request(`/api/admin/profiles/${staff.id}/role`, {
    token: rootToken,
    method: "PATCH",
    body: { role: "admin" },
  });
  record("super admin can promote approved staff to admin", promote.response.ok && normalizeRole(promote.payload.profile?.role) === "admin", promote.payload.error || normalizeRole(promote.payload.profile?.role));

  const adminLogin = await request("/api/auth/login", { method: "POST", body: { email: staffEmail, password } });
  const adminToken = adminLogin.payload.session?.access_token;
  record("promoted admin can login as admin", adminLogin.response.ok && normalizeRole(adminLogin.payload.profile?.role) === "admin", adminLogin.payload.error || normalizeRole(adminLogin.payload.profile?.role));

  const adminOverview = await request("/api/admin/overview", { token: adminToken });
  record("admin can access admin overview", adminOverview.response.ok, `${adminOverview.response.status}`);

  const adminSentinel = await request("/api/security/status", { token: adminToken });
  record("admin cannot access Sentinel", adminSentinel.response.status === 403, `${adminSentinel.response.status}`);

  const rootSentinel = await request("/api/security/status", { token: rootToken });
  record("super admin can access Sentinel", rootSentinel.response.ok, `${rootSentinel.response.status}`);
} finally {
  await cleanup();
}

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  process.exitCode = 1;
}
