import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 4000);
const uploadRoot = path.resolve(__dirname, "..", "uploads", "protected");
const renderRoot = path.resolve(__dirname, "..", "uploads", "rendered-pages");
const standardFontDataUrl = `${path.resolve(__dirname, "..", "node_modules", "pdfjs-dist", "standard_fonts")}${path.sep}`;
const allowedExtensions = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx"]);
const allowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const STAFF_VERIFICATION_PHRASE =
  String(process.env.STAFF_VERIFICATION_PHRASE || "").trim().toUpperCase();

const ROOT_SUPER_ADMIN_EMAIL =
  String(process.env.ROOT_SUPER_ADMIN_EMAIL || "").trim().toLowerCase();

const ROOT_SUPER_ADMIN_PASSWORD =
  String(process.env.ROOT_SUPER_ADMIN_PASSWORD || "").trim();

const ROOT_SUPER_ADMIN_SECRET_PHRASE =
  String(process.env.ROOT_SUPER_ADMIN_SECRET_PHRASE || "").trim().toLowerCase();

const ROOT_SUPER_ADMIN_SESSION_PASSWORD =
  String(process.env.ROOT_SUPER_ADMIN_SESSION_PASSWORD || "").trim();

const requiredRootAdminEnv = {
  ROOT_SUPER_ADMIN_EMAIL,
  ROOT_SUPER_ADMIN_PASSWORD,
  ROOT_SUPER_ADMIN_SECRET_PHRASE,
  ROOT_SUPER_ADMIN_SESSION_PASSWORD,
};

const missingRootAdminEnv = Object.entries(requiredRootAdminEnv)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingRootAdminEnv.length > 0) {
  throw new Error(
    `Missing required root admin environment variables: ${missingRootAdminEnv.join(", ")}`
  );
}

const sensitiveMetadataKeys = new Set([
  "password",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "credential",
  "secret",
  "authorization",
  "cookie",
]);

fs.mkdirSync(uploadRoot, { recursive: true });
fs.mkdirSync(renderRoot, { recursive: true });

// The backend owns all privileged Supabase operations. The service role key must never reach the browser.
const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const missingEnv = requiredEnv.filter(
  (key) =>
    !process.env[key] ||
    process.env[key]?.startsWith("replace-with")
);

const supabasePublic =
  missingEnv.includes("SUPABASE_URL") ||
  missingEnv.includes("SUPABASE_PUBLISHABLE_KEY")
    ? null
    : createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_PUBLISHABLE_KEY,
        {
          auth: { persistSession: false },
        }
      );

const supabaseAdmin =
  missingEnv.includes("SUPABASE_URL") ||
  missingEnv.includes("SUPABASE_SERVICE_ROLE_KEY")
    ? null
    : createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: { persistSession: false },
        }
      );

const frontendOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const isProduction = process.env.NODE_ENV === "production";

app.disable("x-powered-by");

app.use(
  helmet({
    // Local dev loads CDN tools directly; keep CSP off there so the browser does not report false app-level violations.
    contentSecurityPolicy: isProduction ? undefined : false,
  })
);

app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || frontendOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("Origin is not allowed by NEXA API CORS policy")
      );
    },
    credentials: true,
  })
);

app.use("/api/auth", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  next();
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.GENERAL_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(
    process.env.AUTH_RATE_LIMIT ||
      (isProduction ? 5 : 50)
  ),
  standardHeaders: true,
  legacyHeaders: false,
});

// Email availability checks happen during signup typing/attempts, so they need a gentler limit than login.
const emailCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

const upload = multer({
  // Files are staged on disk first, then metadata is written to Supabase.
  dest: uploadRoot,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 1,
  },
  fileFilter(_req, file, callback) {
    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    if (
      !allowedExtensions.has(extension) ||
      !allowedMimeTypes.has(file.mimetype)
    ) {
      return callback(
        new Error(
          "Only PDF, DOCX, and PPTX files are allowed"
        )
      );
    }

    return callback(null, true);
  },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const rootLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  secretPhrase: z.string().min(3),
});

const rootResetLinkSchema = z.object({
  email: z.string().email(),
  redirectTo: z.string().url().optional(),
});

const emptyStringToUndefined = (value) => {
  if (typeof value !== "string") return value;
  return value.trim() === "" ? undefined : value;
};

const optionalText = (max = 160) =>
  z.preprocess(
    emptyStringToUndefined,
    z.string().max(max).optional()
  );

const optionalEmail = z.preprocess(
  emptyStringToUndefined,
  z.string().email().optional()
);

const optionalToken = z.preprocess(
  emptyStringToUndefined,
  z.string().min(10).optional()
);

const profileSchema = z.object({
  name: z.string().min(2).max(120),
  role: z.enum([
    "Student",
    "Staff",
    "Admin",
    "Super Admin",
    "student",
    "staff",
    "admin",
    "super_admin",
  ]),
  department: optionalText(160),
  matricNumber: optionalText(80),
  level: optionalText(40),
  staffId: optionalText(80),
  staffEmail: optionalEmail,
  title: optionalText(120),
  status: z
    .enum([
      "active",
      "pending",
      "suspended",
      "Active",
      "Pending",
      "Suspended",
    ])
    .optional(),
});

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  profile: profileSchema,
});

const emailSchema = z.object({
  email: z.string().email(),
  recaptchaToken: z.string().optional(),
});

const otpSchema = z.object({
  email: z.string().email(),
  token: z.string().min(4).max(12),
});

const resetLinkSchema = z.object({
  email: z.string().email(),
  redirectTo: z.string().url().optional(),
});

const supportSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  message: z.string().min(2).max(2000),
});

const supportReplySchema = z.object({
  supportRequestId: z.string().uuid().optional(),
  to: z.string().email(),
  subject: z.string().min(2).max(180),
  message: z.string().min(2).max(2000),
});

const updatePasswordSchema = z.object({
  accessToken: z.string().min(10),
  refreshToken: z.string().min(10).optional(),
  password: z.string().min(8),
});

const completeOtpSignupSchema = z.object({
  email: z.string().email().optional(),
  accessToken: z.string().min(10).optional(),
  refreshToken: z.string().min(10).optional(),
  password: z.string().min(8),
  profile: profileSchema,
});

const googleCompleteSchema = z
  .object({
    accessToken: optionalToken,
    credential: optionalToken,
    password: z.string().min(8),
    profile: profileSchema,
  })
  .refine(
    (value) =>
      Boolean(value.accessToken || value.credential),
    {
      message: "Google credential is required",
    }
  );

const statusSchema = z.object({
  mode: z.enum([
    "NORMAL",
    "WARNING",
    "LOCKDOWN",
    "MAINTENANCE",
  ]),
  reason: z.string().max(500).optional(),
});

const alertStatusSchema = z.object({
  status: z.enum([
    "open",
    "acknowledged",
    "investigating",
    "resolved",
  ]),
});

const profileStatusSchema = z.object({
  status: z.enum([
    "active",
    "pending",
    "suspended",
  ]),
  reviewComment: z.string().max(500).optional(),
});

const profileRoleSchema = z.object({
  role: z.enum(["staff", "hod", "admin"]),
  reason: z.string().max(500).optional(),
});

const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().min(4).max(500),
});

const notificationSchema = z.object({
  title: z.string().min(2).max(140),
  body: z.string().min(2).max(700),
  targetRole: z.enum([
    "all",
    "student",
    "staff",
    "hod",
    "admin",
    "super_admin",
  ]),
});

const rootSettingsSchema = z.object({
  theme: z.string().min(1).max(120),
  accent: z.enum(["Gold", "Emerald"]),
  dashboardTitle: z.string().min(1).max(160),
  welcomeText: z.string().min(1).max(500),
  defaultAdminRole: z.string().min(1).max(80),
  maintenanceEnabled: z.boolean(),
  maintenanceMessage: z.string().min(4).max(500),
});

const saveResourceSchema = z.object({
  resourceType: z.enum(["project", "material"]),
  resourceId: z.string().uuid(),
});

const reviewUploadSchema = z.object({
  resourceType: z.enum(["project", "material"]),
  resourceId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(700).optional(),
});

const uploadMetadataSchema = z.object({
  title: z.string().min(1).max(220).optional(),
  kind: z.enum(["Project", "Material"]).optional(),
  category: z.string().max(80).optional(),
  abstract: z.string().max(8000).optional(),
  year: z.coerce.number().int().min(1990).max(2100).optional(),
  supervisor: z.string().max(180).optional(),
  authors: z.string().max(1000).optional(),
  bookId: z.string().max(80).optional(),
  cabinet: z.string().max(80).optional(),
  row: z.string().max(80).optional(),
  column: z.string().max(80).optional(),
  courseCode: z.string().max(40).optional(),
  courseTitle: z.string().max(180).optional(),
  level: z
    .enum([
      "100L",
      "200L",
      "300L",
      "400L",
      "500L",
    ])
    .optional(),
  materialType: z.string().max(80).optional(),
});

const gmailOtpStore = new Map();

function clientIp(req) {
  return (
    req.headers["x-forwarded-for"]
      ?.toString()
      .split(",")[0]
      ?.trim() ||
    req.socket.remoteAddress ||
    null
  );
}

function frontendUrl(req) {
  // Supabase email links should return users to the frontend, not the API host.
  const origin =
    frontendOrigins[0] ||
    `${req.protocol}://${req.get("host")}`;

  return origin.replace(/\/$/, "");
}

function redactSensitive(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const normalized = key.toLowerCase();

      const sensitive =
        sensitiveMetadataKeys.has(key) ||
        [...sensitiveMetadataKeys].some(
          (needle) =>
            normalized.includes(needle.toLowerCase())
        );

      return [
        key,
        sensitive
          ? "[redacted]"
          : redactSensitive(item),
      ];
    })
  );
}

function timingSafeEqualString(a = "", b = "") {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) return false;

  return crypto.timingSafeEqual(left, right);
}

async function writeSecurityLog({
  req,
  actor,
  action,
  severity = "info",
  metadata = {},
}) {
  // Security logging is best-effort so auth flows still work if the audit table is unavailable.
  if (missingEnv.length) return;

  try {
    await supabaseAdmin
      .from("security_logs")
      .insert({
        actor_id: actor?.id || null,
        actor_email: actor?.email || null,
        action,
        severity,
        ip_address: clientIp(req),
        user_agent:
          req.headers["user-agent"] || null,
        metadata: redactSensitive(metadata),
      });
  } catch {
    // Audit failures must never block login or core API flows.
  }
}

async function createAlert({
  title,
  severity = "warning",
  metadata = {},
}) {
  if (missingEnv.length) return;

  const { error } = await supabaseAdmin
    .from("security_alerts")
    .insert({
      title,
      severity,
      metadata,
    });

  if (
    error &&
    !isMissingRelationOrColumn(error)
  ) {
    throw error;
  }

  await sendTelegramAlert(
    title,
    severity,
    metadata
  );
}

function gmailConfigured() {
  return Boolean(
    process.env.GMAIL_USER &&
      process.env.GMAIL_APP_PASSWORD
  );
}

function smtpEncode(value = "") {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function smtpDataEscape(value = "") {
  return String(value)
    .replace(/\r?\n/g, "\r\n")
    .replace(/^\./gm, "..");
}

function htmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      buffer += chunk.toString("utf8");

      const lines = buffer
        .split(/\r?\n/)
        .filter(Boolean);

      const last = lines[lines.length - 1] || "";

      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve(buffer);
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function smtpCommand(
  socket,
  command,
  expected = /^[23]/
) {
  if (command) {
    socket.write(`${command}\r\n`);
  }

  const response = await smtpRead(socket);

  if (!expected.test(response)) {
    throw new Error(
      `SMTP command failed: ${
        response.split(/\r?\n/)[0]
      }`
    );
  }

  return response;
}

async function sendGmailMail({
  to,
  subject,
  text,
  html,
  replyTo,
}) {
  if (!gmailConfigured()) return false;

  const from =
    process.env.GMAIL_FROM ||
    process.env.GMAIL_USER;

  const boundary = `nexaa-${crypto.randomUUID()}`;

  const socket = tls.connect(
    465,
    "smtp.gmail.com",
    {
      servername: "smtp.gmail.com",
    }
  );

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(
        "secureConnect",
        onSecureConnect
      );
      socket.off("error", onError);
    };

    const onSecureConnect = () => {
      cleanup();
      resolve();
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    socket.once(
      "secureConnect",
      onSecureConnect
    );

    socket.once("error", onError);
  });

  try {
    await smtpCommand(socket, null);
    await smtpCommand(
      socket,
      "EHLO nexaa.local"
    );

    await smtpCommand(
      socket,
      "AUTH LOGIN",
      /^334/
    );

    await smtpCommand(
      socket,
      Buffer.from(
        process.env.GMAIL_USER
      ).toString("base64"),
      /^334/
    );

    await smtpCommand(
      socket,
      Buffer.from(
        process.env.GMAIL_APP_PASSWORD
      ).toString("base64")
    );

    await smtpCommand(
      socket,
      `MAIL FROM:<${from}>`
    );

    await smtpCommand(
      socket,
      `RCPT TO:<${to}>`
    );

    await smtpCommand(
      socket,
      "DATA",
      /^354/
    );

    const headers = [
      `From: ${smtpEncode(
        process.env.GMAIL_FROM_NAME ||
          "Nexaa Archive"
      )} <${from}>`,
      `To: <${to}>`,
      `Subject: ${smtpEncode(subject)}`,
      replyTo
        ? `Reply-To: ${smtpEncode(replyTo)}`
        : "",
      "MIME-Version: 1.0",
      html
        ? `Content-Type: multipart/alternative; boundary="${boundary}"`
        : "Content-Type: text/plain; charset=UTF-8",
    ]
      .filter(Boolean)
      .join("\r\n");

    const body = html
      ? [
          `--${boundary}`,
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: 7bit",
          "",
          text,
          `--${boundary}`,
          "Content-Type: text/html; charset=UTF-8",
          "Content-Transfer-Encoding: 7bit",
          "",
          html,
          `--${boundary}--`,
          "",
        ].join("\r\n")
      : text;

    socket.write(
      `${headers}\r\n\r\n${smtpDataEscape(
        body
      )}\r\n.\r\n`
    );

    await smtpCommand(socket, null);

    await smtpCommand(
      socket,
      "QUIT",
      /^221/
    );

    return true;
  } finally {
    socket.end();
  }
}

function brandedOtpEmail({ email, otp }) {
  const safeEmail = htmlEscape(email);
  const safeOtp = htmlEscape(otp);

  // SECURITY: support email comes from .env only.
  const supportEmail = htmlEscape(
    process.env.SUPPORT_ADMIN_EMAIL || ""
  );

  const text = [
    `Hello,`,
    "",
    `Your Nexaa verification code is ${otp}.`,
    "",
    "This code expires in 10 minutes.",
    "",
    "If you did not request this code, you can ignore this email. Do not share this code with anyone.",
    "",
    supportEmail
      ? `Need help? Contact ${supportEmail}.`
      : "Need help? Please contact Nexaa support.",
    "",
    "Nexaa Archive",
  ].join("\n");

  const supportHtml = supportEmail
    ? `Need help? Contact <a href="mailto:${supportEmail}" style="color:#800080;text-decoration:none;font-weight:700;">${supportEmail}</a>.`
    : "Need help? Please contact Nexaa support.";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Nexaa verification code</title>
  </head>
  <body style="margin:0;background:#f8f2f8;font-family:Inter,Arial,sans-serif;color:#211827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f2f8;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #ead8ea;border-radius:24px;overflow:hidden;box-shadow:0 20px 55px rgba(128,0,128,.12);">
            <tr>
              <td style="padding:28px 30px 18px;background:linear-gradient(135deg,#800080,#a619a6);color:#ffffff;">
                <div style="display:inline-block;width:42px;height:42px;border-radius:14px;background:#ffffff;color:#800080;text-align:center;line-height:42px;font-size:22px;font-weight:900;margin-bottom:14px;">N</div>
                <div style="font-size:26px;font-weight:800;letter-spacing:.2px;">Nexaa</div>
                <div style="margin-top:6px;font-size:13px;opacity:.9;">Academic Archive Verification</div>
              </td>
            </tr>
            <tr>
              <td style="padding:30px;">
                <h1 style="margin:0 0 10px;font-size:24px;line-height:1.2;color:#211827;">Verify your email</h1>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#6f5a72;">Hello, use the code below to continue creating your Nexaa account for <strong style="color:#211827;">${safeEmail}</strong>.</p>
                <div style="margin:22px 0;padding:20px;border-radius:18px;background:#fbf4fb;border:1px solid #ead8ea;text-align:center;">
                  <div style="font-size:12px;font-weight:700;color:#800080;text-transform:uppercase;letter-spacing:.12em;">Verification Code</div>
                  <div style="margin-top:10px;font-size:38px;line-height:1;font-weight:900;letter-spacing:.18em;color:#800080;">${safeOtp}</div>
                </div>
                <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#6f5a72;">This code expires in <strong style="color:#211827;">10 minutes</strong>.</p>
                <p style="margin:0;padding:14px 16px;border-radius:14px;background:#fff9df;border:1px solid #eadf9a;font-size:13px;line-height:1.55;color:#5c4b00;">Security notice: Nexaa will never ask you to share this code. If you did not request it, you can safely ignore this email.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 30px 28px;border-top:1px solid #f0e4f0;color:#7c687f;font-size:12px;line-height:1.6;">
                ${supportHtml}<br>
                Nexaa Archive · Preserving Knowledge. Powering the Next.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    text,
    html,
  };
}

function normalizeRole(role = "student") {
  const value = String(role)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (value === "super_admin") {
    return "super_admin";
  }

  if (
    ["admin", "hod", "staff", "student"].includes(
      value
    )
  ) {
    return value;
  }

  return "student";
}

function isPublicSignupRole(
  role = "student"
) {
  return ["student", "staff"].includes(
    normalizeRole(role)
  );
}

function publicSignupProfileError(
  profile = {}
) {
  const role = normalizeRole(profile.role);

  if (!isPublicSignupRole(role)) {
    return "Only student and staff accounts can be created from signup";
  }

  if (role === "staff") {
    if (
      !/@futa\.edu\.ng$/i.test(
        String(profile.staffEmail || "")
      )
    ) {
      return "Only valid FUTA staff email addresses can register as staff";
    }

    if (
      String(profile.staffId || "")
        .trim()
        .toUpperCase() !==
      STAFF_VERIFICATION_PHRASE
    ) {
      return "Invalid staff verification phrase";
    }
  }

  return "";
}

function pendingStaffIdForUser(user = {}) {
  const seed = String(
    user.id || crypto.randomUUID()
  )
    .replace(/-/g, "")
    .slice(0, 10)
    .toUpperCase();

  return `PENDING-${seed}`;
}

function profileStaffIdForSave(
  user = {},
  profilePayload = {},
  role = normalizeRole(
    profilePayload.role
  ),
  status = normalizeStatus(
    profilePayload.status
  )
) {
  if (role === "student") return null;

  const raw = String(
    profilePayload.staffId || ""
  ).trim();

  if (
    role === "staff" &&
    status === "pending" &&
    raw.toUpperCase() ===
      STAFF_VERIFICATION_PHRASE
  ) {
    return pendingStaffIdForUser(user);
  }

  return (
    raw || pendingStaffIdForUser(user)
  );
}

function generateStaffIdCode() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let suffix = "";

  for (
    let index = 0;
    index < 8;
    index += 1
  ) {
    suffix += chars[
      crypto.randomInt(chars.length)
    ];
  }

  return `ARE${suffix}`;
}

async function generateUniqueStaffId() {
  for (
    let attempt = 0;
    attempt < 12;
    attempt += 1
  ) {
    const code = generateStaffIdCode();

    const {
      data,
      error,
    } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("staff_id", code)
      .maybeSingle();

    if (error) throw error;

    if (!data) return code;
  }

  throw new Error(
    "Could not generate a unique staff ID"
  );
}

async function googleProfileFromToken({
  accessToken = "",
  credential = "",
} = {}) {
  const endpoint = accessToken
    ? "https://www.googleapis.com/oauth2/v3/userinfo"
    : `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(
        credential
      )}`;

  const response = await fetch(
    endpoint,
    accessToken
      ? {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      : undefined
  );

  if (!response.ok) {
    throw new Error(
      "Google sign in failed"
    );
  }

  const profile = await response.json();

  if (!profile.email) {
    throw new Error(
      "Google account email is missing"
    );
  }

  if (
    profile.email_verified === false ||
    profile.email_verified === "false"
  ) {
    throw new Error(
      "Google email is not verified"
    );
  }

  if (
    credential &&
    process.env.GOOGLE_CLIENT_ID &&
    profile.aud &&
    profile.aud !==
      process.env.GOOGLE_CLIENT_ID
  ) {
    throw new Error(
      "Google OAuth audience mismatch"
    );
  }

  return profile;
}

async function findAuthUserByEmail(email) {
  const normalized = String(
    email || ""
  ).toLowerCase();

  const {
    data,
    error,
  } = await supabaseAdmin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;

  return (
    data.users?.find(
      (user) =>
        String(user.email || "")
          .toLowerCase() === normalized
    ) || null
  );
}

function normalizeStatus(status = "active") {
  const value = String(status || "active").trim().toLowerCase();
  return ["active", "pending", "suspended"].includes(value) ? value : "active";
}

function authUserMetadata(profile = {}) {
  const role = normalizeRole(profile.role);
  const rawStaffId = String(profile.staffId || "").trim();

  const pendingSeed = crypto
    .createHash("sha1")
    .update(
      String(
        profile.email ||
          profile.staffEmail ||
          profile.name ||
          crypto.randomUUID()
      ).toLowerCase()
    )
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();

  const safeStaffId =
    role === "staff" &&
    rawStaffId.toUpperCase() ===
      STAFF_VERIFICATION_PHRASE
      ? `PENDING-${pendingSeed}`
      : rawStaffId ||
        (role !== "student"
          ? `PENDING-${pendingSeed}`
          : null);

  return {
    name: profile.name,
    full_name: profile.name,
    role,
    department: profile.department || null,
    matric_number:
      role === "student"
        ? profile.matricNumber || null
        : null,
    level:
      role === "student"
        ? profile.level || null
        : null,
    staff_id:
      role !== "student"
        ? safeStaffId
        : null,
    staff_email:
      role !== "student"
        ? profile.staffEmail || null
        : null,
    title:
      role !== "student"
        ? profile.title || null
        : null,
    status:
      role === "student"
        ? "active"
        : normalizeStatus(
            profile.status || "pending"
          ),
  };
}

function frontendUser(user = {}) {
  return {
    id: user.id,
    email: user.email,
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at,
    app_metadata: {
      role: user.app_metadata?.role
        ? normalizeRole(
            user.app_metadata.role
          )
        : undefined,
      provider: user.app_metadata?.provider,
      providers: user.app_metadata?.providers,
    },
  };
}

function frontendSession(session = null) {
  if (!session) return null;

  return {
    access_token: session.access_token,
    token_type:
      session.token_type || "bearer",
    expires_in: session.expires_in,
    expires_at: session.expires_at,
  };
}

function authPayload({
  session = null,
  user = {},
  profile = {},
  extra = {},
} = {}) {
  return {
    ...extra,
    session: frontendSession(session),
    user: frontendUser(user),
    profile: frontendProfile(
      profile,
      user
    ),
  };
}

function frontendProfile(
  profile = {},
  user = {}
) {
  const role = normalizeRole(profile.role);
  const staffId = String(
    profile.staff_id || ""
  );

  return {
    id: profile.id || user.id,

    name:
      profile.full_name ||
      profile.name ||
      user.user_metadata?.name ||
      user.email,

    email:
      profile.email ||
      user.email,

    role:
      role === "super_admin"
        ? "Super Admin"
        : role.charAt(0).toUpperCase() +
          role.slice(1),

    department:
      profile.department || "",

    matricNumber:
      profile.matric_number || "",

    level:
      profile.level || "",

    staffId:
      staffId.startsWith("PENDING-")
        ? ""
        : staffId,

    staffEmail:
      profile.staff_email || "",

    title:
      profile.title || "",

    status:
      profile.status || "active",

    createdAt:
      profile.created_at || "",

    updatedAt:
      profile.updated_at || "",
  };
}

function frontendProject(row = {}) {
  return {
    id: row.id,
    title: row.title,
    abstract: row.abstract || "",
    type:
      row.type ||
      row.category ||
      "Final Year Project",

    category:
      row.category || "FYP",

    year: row.year
      ? String(row.year)
      : "",

    level:
      row.level || "",

    meta:
      row.meta ||
      row.department ||
      row.supervisor ||
      "",

    authors:
      row.authors || [],

    supervisor:
      row.supervisor || "",

    bookId:
      row.book_id ||
      row.bookId ||
      "",

    cabinet:
      row.cabinet || "",

    row:
      row.archive_row ||
      row.row ||
      "",

    column:
      row.archive_column ||
      row.column ||
      "",

    backendFileId:
      row.protected_file_id || "",

    filePath:
      row.file_path || "",

    backendFileId:
      row.protected_file_id || "",

    status:
      row.status,

    createdAt:
      row.created_at,

    source: "supabase",
  };
}

function frontendMaterial(row = {}) {
  return {
    id: row.id,
    title: row.title,

    code:
      row.course_code,

    courseTitle:
      row.course_title ||
      row.title,

    level:
      row.level,

    type:
      row.material_type ===
      "past_question"
        ? "Past Questions"
        : row.material_type === "slide"
          ? "Slides"
          : "PDF",

    year: row.year
      ? String(row.year)
      : "",

    department:
      row.department || "",

    filePath:
      row.file_path || "",

    backendFileId:
      row.protected_file_id || "",

    status:
      row.status,

    createdAt:
      row.created_at,

    source: "supabase",
  };
}

function frontendStaffUpload(
  row = {},
  kind = "Project",
  uploader = {}
) {
  const label = String(
    row.status || "pending_review"
  )
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(
      (part) =>
        part.charAt(0).toUpperCase() +
        part.slice(1)
    )
    .join(" ");

  return {
    id: row.id,

    kind,

    title:
      row.title ||
      row.course_title ||
      "Untitled upload",

    status:
      label || "Pending Review",

    reviewComment:
      row.review_comment || "",

    uploader:
      uploader.full_name ||
      uploader.name ||
      uploader.email ||
      "Staff",

    uploaderEmail:
      uploader.email || "",

    uploaderId:
      row.uploaded_by || "",

    department:
      row.department || "",

    fileName:
      row.file_path || "",

    type:
      row.material_type ||
      row.category ||
      kind,

    backendFileId:
      row.protected_file_id || "",

    at:
      row.created_at,

    reviewedAt:
      row.reviewed_at || "",

    reviewedBy:
      row.reviewed_by || "",
  };
}

function canManageDepartment(
  profile = {}
) {
  return [
    "hod",
    "admin",
    "super_admin",
  ].includes(
    normalizeRole(profile.role)
  );
}

function notificationRoleForProfile(
  profile = {}
) {
  const role = normalizeRole(
    profile.role
  );

  return [
    "student",
    "staff",
    "hod",
    "admin",
    "super_admin",
  ].includes(role)
    ? role
    : "student";
}

function frontendSavedId(row = {}) {
  if (row.project_id) {
    return `project:${row.project_id}`;
  }

  if (row.material_id) {
    return `material:${row.material_id}`;
  }

  return "";
}

function isMissingRelationOrColumn(
  error
) {
  const text = String(
    error?.message ||
      error?.details ||
      error?.hint ||
      error?.code ||
      ""
  ).toLowerCase();

  return (
    [
      "42p01",
      "42703",
      "pgrst200",
      "pgrst204",
    ].includes(
      String(error?.code || "").toLowerCase()
    ) ||
    text.includes("does not exist") ||
    text.includes("could not find") ||
    text.includes("schema cache")
  );
}

function titleCase(value = "") {
  return String(value || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(
      (part) =>
        part.charAt(0).toUpperCase() +
        part.slice(1).toLowerCase()
    )
    .join(" ");
}

const sentinelSeedThreats = [
  {
    ip_address: "104.21.32.18",
    category: "Credential spray",
    status: "blocked",
    severity: "critical",
    threat_score: 94,
    request_count: 8942,
    description:
      "Repeated admin-route probes from an edge cluster.",
    source: "gateway",
  },

  {
    ip_address: "196.45.102.9",
    category: "Unusual traffic",
    status: "monitored",
    severity: "high",
    threat_score: 72,
    request_count: 4188,
    description:
      "Burst traffic against archive search endpoints.",
    source: "rate-limit",
  },

  {
    ip_address: "41.203.71.11",
    category: "Normal activity",
    status: "allowed",
    severity: "low",
    threat_score: 31,
    request_count: 1207,
    description:
      "Authenticated student archive browsing.",
    source: "gateway",
  },

  {
    ip_address: "172.64.80.45",
    category: "API abuse",
    status: "challenged",
    severity: "high",
    threat_score: 81,
    request_count: 6335,
    description:
      "Adaptive challenge issued after request anomaly.",
    source: "recaptcha",
  },

  {
    ip_address: "102.89.12.108",
    category: "Normal activity",
    status: "allowed",
    severity: "low",
    threat_score: 22,
    request_count: 903,
    description:
      "Low-risk local traffic.",
    source: "gateway",
  },
];

const sentinelDefaultSettings = {
  policies: {
    "Rate limits": "1,200 req/min",
    "Timeout rules": "12 min admin",
    "Lock thresholds": "10 failed attempts",
    "Archive write window": "06:00-23:00",
  },

  api_controls: {
    "API keys": "Server only",
    "Token status": "Access-token only",
    "Endpoint restrictions":
      "Mutation protected",
    "Webhook signing": "Required",
  },

  infrastructure_controls: {
    controls: [
      "Gateway monitor",
      "Storage sentinel",
      "Backup verifier",
      "Role anomaly model",
      "Alert router",
      "Geo challenge engine",
    ],
  },
};

const defaultRootSettings = {
  theme: "Nexaa Classic",
  accent: "Gold",
  dashboard_title: "Root Control Center",

  welcome_text:
    "Manage users, reviews, staff IDs, uploads, and archive operations.",

  default_admin_role: "Admin",

  maintenance_enabled: false,

  maintenance_message:
    "Maintenance in progress. Please check back shortly.",
};

async function tableCount(table) {
  const {
    count,
    error,
  } = await supabaseAdmin
    .from(table)
    .select("id", {
      count: "exact",
      head: true,
    });

  if (error) throw error;

  return count || 0;
}

async function seedSecurityDefaults() {
  if (missingEnv.length) return;

  try {
    await supabaseAdmin
      .from("security_system_status")
      .upsert(
        {
          singleton_key: true,
        },
        {
          onConflict: "singleton_key",
        }
      );

    const {
      data: existingSettings,
      error: settingsError,
    } = await supabaseAdmin
      .from("security_settings")
      .select("id")
      .eq("singleton_key", true)
      .maybeSingle();

    if (settingsError) {
      throw settingsError;
    }

    if (!existingSettings) {
      await supabaseAdmin
        .from("security_settings")
        .insert({
          singleton_key: true,
          ...sentinelDefaultSettings,
        });
    }

    const {
      data: existingRootSettings,
      error: rootSettingsError,
    } = await supabaseAdmin
      .from("admin_root_settings")
      .select("id")
      .eq("singleton_key", true)
      .maybeSingle();

    if (
      rootSettingsError &&
      !isMissingRelationOrColumn(
        rootSettingsError
      )
    ) {
      throw rootSettingsError;
    }

    if (
      !existingRootSettings &&
      !rootSettingsError
    ) {
      await supabaseAdmin
        .from("admin_root_settings")
        .insert({
          singleton_key: true,
          ...defaultRootSettings,
        });
    }

    if (
      (await tableCount(
        "security_threats"
      )) === 0
    ) {
      await supabaseAdmin
        .from("security_threats")
        .insert(sentinelSeedThreats);
    }

    if (
      (await tableCount(
        "security_monitoring_snapshots"
      )) === 0
    ) {
      await supabaseAdmin
        .from(
          "security_monitoring_snapshots"
        )
        .insert({
          requests_per_second: 1284,
          api_usage_percent: 78,
          suspicious_routes: 9,
          average_response_ms: 42,

          active_connections: [
            { city: "Lagos" },
            { city: "Abuja" },
            { city: "London" },
            { city: "Accra" },
          ],

          resource_usage: {
            CPU: 48,
            RAM: 62,
            Storage: 73,
            Bandwidth: 54,
          },

          heatmap: Array.from(
            { length: 84 },
            (_, index) =>
              (index * 7) % 5
          ),
        });
    }

    if (
      (await tableCount(
        "security_backup_points"
      )) === 0
    ) {
      await supabaseAdmin
        .from("security_backup_points")
        .insert([
          {
            label: "02:00",
            size_label: "81.4 GB",
            status: "successful",
            integrity: "Verified",
            storage_target:
              "Object store",
          },

          {
            label: "20:00",
            size_label: "80.9 GB",
            status: "successful",
            integrity: "Verified",
            storage_target:
              "Object store",
          },

          {
            label: "14:00",
            size_label: "80.1 GB",
            status: "warning",
            integrity: "Rechecking",
            storage_target:
              "Cold archive",
          },

          {
            label: "08:00",
            size_label: "79.8 GB",
            status: "successful",
            integrity: "Verified",
            storage_target:
              "Object store",
          },
        ]);
    }
  } catch (error) {
    if (!isMissingRelationOrColumn(error)) {
      throw error;
    }
  }
}

function frontendRootSettings(row = {}) {
  row = row || {};

  return {
    theme:
      row.theme ||
      defaultRootSettings.theme,

    accent:
      row.accent ||
      defaultRootSettings.accent,

    dashboardTitle:
      row.dashboard_title ||
      defaultRootSettings.dashboard_title,

    welcomeText:
      row.welcome_text ||
      defaultRootSettings.welcome_text,

    defaultAdminRole:
      row.default_admin_role ||
      defaultRootSettings.default_admin_role,

    maintenanceEnabled:
      Boolean(row.maintenance_enabled),

    maintenanceMessage:
      row.maintenance_message ||
      defaultRootSettings.maintenance_message,

    notifications:
      Array.isArray(row.notifications)
        ? row.notifications
        : [],

    updatedAt:
      row.updated_at || "",
  };
}

function frontendStaffId(profile = {}) {
  const staffId = String(
    profile.staff_id || ""
  );

  return {
    id: profile.id,

    code:
      staffId.startsWith("PENDING-") ||
      !staffId
        ? "Pending approval"
        : staffId,

    name:
      profile.full_name ||
      profile.email ||
      "Unassigned",

    email:
      profile.email || "",

    department:
      profile.department || "",

    status:
      profile.status === "active"
        ? "Assigned"
        : titleCase(
            profile.status || "Pending"
          ),

    issuedAt:
      profile.updated_at ||
      profile.created_at ||
      "",
  };
}

function frontendSecurityStatus(
  row = {}
) {
  row = row || {};

  const mode = String(
    row.mode || "NORMAL"
  ).toUpperCase();

  return {
    mode,

    modeSlug:
      mode.toLowerCase(),

    reason:
      row.reason || "",

    changedBy:
      row.changed_by || "",

    changedAt:
      row.changed_at ||
      row.updated_at ||
      row.created_at ||
      "",
  };
}

function frontendSecurityLog(row = {}) {
  return {
    id: row.id,

    at:
      row.created_at ||
      new Date().toISOString(),

    type:
      titleCase(
        row.severity || "info"
      ),

    actor:
      row.actor_email || "System",

    action:
      row.action || "",

    message:
      titleCase(
        String(
          row.action ||
            "security.event"
        ).replace(/\./g, " ")
      ),

    severity:
      row.severity || "info",

    ip:
      row.ip_address || "",

    metadata:
      row.metadata || {},
  };
}

function frontendSecurityAlert(
  row = {}
) {
  return {
    id: row.id,

    title:
      row.title ||
      "Security alert",

    severity:
      row.severity || "warning",

    status:
      row.status || "open",

    metadata:
      row.metadata || {},

    acknowledgedAt:
      row.acknowledged_at || "",

    createdAt:
      row.created_at || "",
  };
}

function frontendSecurityThreat(
  row = {}
) {
  return {
    id: row.id,

    ip:
      row.ip_address || "",

    category:
      row.category || "Threat",

    status:
      titleCase(
        row.status || "monitored"
      ),

    severity:
      row.severity || "medium",

    score:
      Number(row.threat_score || 0),

    requests:
      Number(row.request_count || 0),

    description:
      row.description || "",

    source:
      row.source || "",

    lastSeen:
      row.last_seen_at ||
      row.created_at ||
      "",
  };
}

function frontendSecuritySnapshot(
  row = {}
) {
  row = row || {};

  return {
    requestsPerSecond:
      Number(
        row.requests_per_second || 0
      ),

    apiUsagePercent:
      Number(
        row.api_usage_percent || 0
      ),

    suspiciousRoutes:
      Number(
        row.suspicious_routes || 0
      ),

    averageResponseMs:
      Number(
        row.average_response_ms || 0
      ),

    activeConnections:
      Array.isArray(
        row.active_connections
      )
        ? row.active_connections
        : [],

    resourceUsage:
      row.resource_usage || {},

    heatmap:
      Array.isArray(row.heatmap)
        ? row.heatmap
        : [],

    createdAt:
      row.created_at || "",
  };
}

function frontendSecurityBackup(
  row = {}
) {
  return {
    id: row.id,

    label:
      row.label || "",

    size:
      row.size_label || "",

    status:
      titleCase(
        row.status || "pending"
      ),

    integrity:
      row.integrity || "",

    target:
      row.storage_target || "",

    createdAt:
      row.created_at || "",
  };
}

function frontendSecuritySettings(
  row = {}
) {
  row = row || {};

  return {
    policies:
      row.policies ||
      sentinelDefaultSettings.policies,

    apiControls:
      row.api_controls ||
      sentinelDefaultSettings.api_controls,

    infrastructureControls:
      row.infrastructure_controls ||
      sentinelDefaultSettings.infrastructure_controls,

    updatedAt:
      row.updated_at || "",
  };
}

function materialTypeToDb(type = "") {
  const value = String(type).toLowerCase();

  if (value.includes("past")) {
    return "past_question";
  }

  if (
    value.includes("slide") ||
    value.includes("ppt")
  ) {
    return "slide";
  }

  return "pdf";
}

function countPdfPages(filePath) {
  try {
    const buffer =
      fs.readFileSync(filePath);

    const text =
      buffer.toString("latin1");

    const matches =
      text.match(
        /\/Type\s*\/Page\b/g
      );

    return Math.max(
      1,
      matches?.length || 1
    );
  } catch {
    return 1;
  }
}

function safeCacheName(value = "") {
  return (
    String(value)
      .replace(
        /[^a-zA-Z0-9_-]+/g,
        "-"
      )
      .replace(/^-|-$/g, "") ||
    "file"
  );
}

function drawViewerWatermark(
  ctx,
  width,
  height,
  watermark
) {
  ctx.save();

  ctx.globalAlpha = 0.13;
  ctx.fillStyle = "#8f008f";

  ctx.font = `${Math.max(
    24,
    Math.round(width / 28)
  )}px Arial`;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.translate(
    width / 2,
    height / 2
  );

  ctx.rotate(-Math.PI / 7);

  const stepY = Math.max(
    120,
    Math.round(height / 5)
  );

  for (
    let y = -height;
    y <= height;
    y += stepY
  ) {
    ctx.fillText(
      watermark,
      0,
      y
    );
  }

  ctx.restore();
}

function drawPageFooter(
  ctx,
  width,
  height,
  {
    pageNumber,
    pageCount,
    watermark,
  }
) {
  ctx.save();

  ctx.fillStyle =
    "rgba(255,255,255,0.92)";

  ctx.fillRect(
    0,
    height - 54,
    width,
    54
  );

  ctx.fillStyle = "#5f3b63";

  ctx.font = `${Math.max(
    13,
    Math.round(width / 78)
  )}px Arial`;

  ctx.textAlign = "left";

  ctx.fillText(
    watermark,
    28,
    height - 22
  );

  ctx.textAlign = "right";

  ctx.fillText(
    `Page ${pageNumber} of ${pageCount}`,
    width - 28,
    height - 22
  );

  ctx.restore();
}

async function renderPdfPageImage({
  file,
  pageNumber,
  watermark,
}) {
  const diskPath =
    path.join(
      uploadRoot,
      file.storage_path
    );

  const data =
    new Uint8Array(
      await fs.promises.readFile(
        diskPath
      )
    );

  const loadingTask =
    pdfjsLib.getDocument({
      data,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: true,
      standardFontDataUrl,
    });

  const pdf =
    await loadingTask.promise;

  const safePage = Math.min(
    Math.max(
      1,
      Number(pageNumber || 1)
    ),
    pdf.numPages
  );

  const cachePath =
    path.join(
      renderRoot,
      `${safeCacheName(
        file.id
      )}-${safeCacheName(
        watermark
      )}-p${safePage}.png`
    );

  if (
    fs.existsSync(cachePath)
  ) {
    return {
      cachePath,
      pageCount: pdf.numPages,
      pageNumber: safePage,
    };
  }

  const page =
    await pdf.getPage(
      safePage
    );

  const viewport =
    page.getViewport({
      scale: 1.55,
    });

  const canvas =
    createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );

  const ctx =
    canvas.getContext("2d");

  ctx.fillStyle = "#fff";

  ctx.fillRect(
    0,
    0,
    canvas.width,
    canvas.height
  );

  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;

  drawViewerWatermark(
    ctx,
    canvas.width,
    canvas.height,
    watermark
  );

  drawPageFooter(
    ctx,
    canvas.width,
    canvas.height,
    {
      pageNumber: safePage,
      pageCount: pdf.numPages,
      watermark,
    }
  );

  await fs.promises.writeFile(
    cachePath,
    canvas.toBuffer("image/png")
  );

  await pdf.destroy();

  return {
    cachePath,
    pageCount: pdf.numPages,
    pageNumber: safePage,
  };
}

async function renderPlaceholderPageImage({
  file,
  pageNumber,
  watermark,
}) {
  const cachePath =
    path.join(
      renderRoot,
      `${safeCacheName(
        file.id
      )}-${safeCacheName(
        watermark
      )}-p${pageNumber}-placeholder.png`
    );

  if (
    fs.existsSync(cachePath)
  ) {
    return {
      cachePath,
      pageCount: 1,
      pageNumber: 1,
    };
  }

  const canvas =
    createCanvas(
      1100,
      1500
    );

  const ctx =
    canvas.getContext("2d");

  ctx.fillStyle = "#fff";

  ctx.fillRect(
    0,
    0,
    canvas.width,
    canvas.height
  );

  ctx.fillStyle =
    "#211827";

  ctx.font =
    "700 46px Arial";

  ctx.fillText(
    file.title ||
      "Protected document",
    84,
    150
  );

  ctx.font =
    "24px Arial";

  ctx.fillStyle =
    "#745f77";

  ctx.fillText(
    file.original_name ||
      "Archive file",
    84,
    205
  );

  ctx.fillText(
    "This file type is protected. Ask the archive administrator for supervised viewing support.",
    84,
    280
  );

  drawViewerWatermark(
    ctx,
    canvas.width,
    canvas.height,
    watermark
  );

  drawPageFooter(
    ctx,
    canvas.width,
    canvas.height,
    {
      pageNumber: 1,
      pageCount: 1,
      watermark,
    }
  );

  await fs.promises.writeFile(
    cachePath,
    canvas.toBuffer("image/png")
  );

  return {
    cachePath,
    pageCount: 1,
    pageNumber: 1,
  };
}

async function findProfile(userId) {
  const { data } =
    await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

  return data || null;
}

async function upsertProfileFromPayload(
  user,
  profilePayload = {}
) {
  // Profile columns in Supabase are snake_case;
  // the frontend works with camelCase.

  const role =
    normalizeRole(
      profilePayload.role
    );

  const status =
    role === "student"
      ? "active"
      : normalizeStatus(
          profilePayload.status ||
            "pending"
        );

  const staffId =
    profileStaffIdForSave(
      user,
      profilePayload,
      role,
      status
    );

  const baseProfile = {
    id: user.id,

    email: user.email,

    full_name:
      profilePayload.name,

    role,

    department:
      profilePayload.department ||
      null,

    matric_number:
      role === "student"
        ? String(
            profilePayload.matricNumber ||
              ""
          )
            .trim()
            .toUpperCase() || null
        : null,

    level:
      role === "student"
        ? profilePayload.level ||
          null
        : null,

    staff_id:
      staffId,

    staff_email:
      role !== "student"
        ? String(
            profilePayload.staffEmail ||
              ""
          )
            .trim()
            .toLowerCase() ||
          null
        : null,

    title:
      role !== "student"
        ? profilePayload.title ||
          null
        : null,

    status,

    updated_at:
      new Date().toISOString(),
  };

  const {
    data,
    error,
  } = await supabaseAdmin
    .from("profiles")
    .upsert(
      baseProfile,
      {
        onConflict: "id",
      }
    )
    .select("*")
    .single();

  if (!error) {
    return data;
  }

  const minimalProfile = {
    id: user.id,

    email: user.email,

    full_name:
      profilePayload.name,

    role,

    department:
      profilePayload.department ||
      null,

    matric_number:
      role === "student"
        ? String(
            profilePayload.matricNumber ||
              ""
          )
            .trim()
            .toUpperCase() || null
        : null,

    level:
      role === "student"
        ? profilePayload.level ||
          null
        : null,

    staff_id:
      staffId,

    staff_email:
      role !== "student"
        ? String(
            profilePayload.staffEmail ||
              ""
          )
            .trim()
            .toLowerCase() ||
          null
        : null,

    status,

    updated_at:
      new Date().toISOString(),
  };

  const retry =
    await supabaseAdmin
      .from("profiles")
      .upsert(
        minimalProfile,
        {
          onConflict: "id",
        }
      )
      .select("*")
      .single();

  if (retry.error) {
    throw retry.error;
  }

  return retry.data;
}

async function sendTelegramAlert(
  title,
  severity,
  metadata
) {
  if (
    !process.env.TELEGRAM_BOT_TOKEN ||
    !process.env.TELEGRAM_CHAT_ID
  ) {
    return;
  }

  const text =
    `NEXA ALERT\n` +
    `Severity: ${severity}\n` +
    `${title}\n` +
    `${JSON.stringify(
      metadata,
      null,
      2
    )}`;

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json",
      },

      body: JSON.stringify({
        chat_id:
          process.env.TELEGRAM_CHAT_ID,
        text,
      }),
    }
  );
}

async function verifyRecaptchaToken(
  token,
  remoteIp
) {
  if (
    !process.env.RECAPTCHA_SECRET_KEY
  ) {
    return true;
  }

  if (!token) {
    return false;
  }

  const body =
    new URLSearchParams({
      secret:
        process.env
          .RECAPTCHA_SECRET_KEY,

      response: token,
    });

  if (remoteIp) {
    body.set(
      "remoteip",
      remoteIp
    );
  }

  const response =
    await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",

        headers: {
          "content-type":
            "application/x-www-form-urlencoded",
        },

        body,
      }
    );

  const data =
    await response
      .json()
      .catch(() => ({}));

  return Boolean(
    data.success
  );
}

async function requireAuth(
  req,
  res,
  next
) {
  // Every protected route accepts the Supabase access token from the browser.

  if (missingEnv.length) {
    return res.status(503).json({
      error:
        "Backend Supabase environment is not configured",
      missingEnv,
    });
  }

  const token =
    req.headers.authorization?.replace(
      /^Bearer\s+/i,
      ""
    );

  if (!token) {
    return res.status(401).json({
      error:
        "Missing bearer token",
    });
  }

  const {
    data,
    error,
  } =
    await supabasePublic.auth.getUser(
      token
    );

  if (
    error ||
    !data.user
  ) {
    await writeSecurityLog({
      req,
      action:
        "auth.token.invalid",
      severity: "warning",
      metadata: {
        error:
          error?.message,
      },
    });

    return res.status(401).json({
      error:
        "Invalid session",
    });
  }

  const {
    data: profile,
    error: profileError,
  } =
    await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();

  if (
    profileError ||
    !profile
  ) {
    return res.status(403).json({
      error:
        "Profile is missing",
    });
  }

  req.user = data.user;
  req.profile = profile;

  return next();
}

function requireRoles(...roles) {
  return (
    req,
    res,
    next
  ) => {
    if (
      req.profile?.status &&
      req.profile.status !==
        "active"
    ) {
      writeSecurityLog({
        req,
        actor:
          req.profile,
        action:
          "auth.status.denied",
        severity: "warning",
        metadata: {
          status:
            req.profile.status,
        },
      });

      return res.status(403).json({
        error:
          "Your account is pending approval",
      });
    }

    if (
      !roles.includes(
        req.profile?.role
      )
    ) {
      writeSecurityLog({
        req,
        actor:
          req.profile,
        action:
          "auth.role.denied",
        severity: "warning",
        metadata: {
          required: roles,
        },
      });

      return res.status(403).json({
        error:
          "Insufficient role",
      });
    }

    return next();
  };
}

async function requireWritableMode(
  req,
  res,
  next
) {
  const { data } =
    await supabaseAdmin
      .from(
        "security_system_status"
      )
      .select("mode")
      .eq(
        "singleton_key",
        true
      )
      .single();

  if (
    ["LOCKDOWN", "MAINTENANCE"].includes(
      data?.mode
    ) &&
    req.profile?.role !== "super_admin"
  ) {
    return res.status(423).json({
      error: `System is in ${data.mode} mode`,
    });
  }

  return next();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: !missingEnv.length,
    service: "nexa-security-api",
    missingEnv,
    gmail: gmailConfigured(),
    storage: "uploads/protected",
  });
});

app.post(
  "/api/auth/root-login",
  loginLimiter,
  async (req, res) => {
    try {
      if (missingEnv.length) {
        return res.status(503).json({
          error:
            "Backend Supabase environment is not configured",
          missingEnv,
        });
      }

      if (!ROOT_SUPER_ADMIN_PASSWORD) {
        return res.status(503).json({
          error:
            "Root password is not configured on the server",
        });
      }

      const parsed =
        rootLoginSchema.safeParse(
          req.body
        );

      if (!parsed.success) {
        return res.status(400).json({
          error:
            "Invalid root login payload",
        });
      }

      const requestedEmail = String(
        parsed.data.email || ""
      )
        .trim()
        .toLowerCase();

      if (
        !timingSafeEqualString(
          requestedEmail,
          ROOT_SUPER_ADMIN_EMAIL
        ) ||
        !timingSafeEqualString(
          parsed.data.password,
          ROOT_SUPER_ADMIN_PASSWORD
        )
      ) {
        await writeSecurityLog({
          req,
          action:
            "auth.root.failed",
          severity: "critical",
          metadata: {
            email:
              requestedEmail ||
              "missing",
          },
        });

        return res.status(401).json({
          error:
            "Invalid root credentials",
        });
      }

      if (
        !timingSafeEqualString(
          String(
            parsed.data.secretPhrase ||
              ""
          )
            .trim()
            .toLowerCase(),
          ROOT_SUPER_ADMIN_SECRET_PHRASE
        )
      ) {
        await writeSecurityLog({
          req,
          action:
            "auth.root.secret_failed",
          severity: "critical",
          metadata: {
            email:
              requestedEmail,
          },
        });

        return res.status(401).json({
          error:
            "Invalid root secret phrase",
        });
      }

      const authUser =
        await findAuthUserByEmail(
          requestedEmail
        );

      if (!authUser) {
        await writeSecurityLog({
          req,
          action:
            "auth.root.missing_user",
          severity: "critical",
          metadata: {
            email:
              requestedEmail,
          },
        });

        return res.status(404).json({
          error:
            "Root account does not exist yet",
        });
      }

      const rootName =
        authUser.user_metadata?.name ||
        authUser.user_metadata?.full_name ||
        "Nexaa Root";

      const {
        data: updatedUser,
        error: updateError,
      } =
        await supabaseAdmin.auth.admin.updateUserById(
          authUser.id,
          {
            password:
              ROOT_SUPER_ADMIN_SESSION_PASSWORD,

            email_confirm: true,

            user_metadata: {
              ...(authUser.user_metadata ||
                {}),
              name: rootName,
              full_name: rootName,
              role: "super_admin",
              status: "active",
            },

            app_metadata: {
              ...(authUser.app_metadata ||
                {}),
              role: "super_admin",
              status: "active",
            },
          }
        );

      if (updateError) {
        await writeSecurityLog({
          req,
          action:
            "auth.root.update_failed",
          severity: "critical",
          metadata: {
            email:
              requestedEmail,
            error:
              updateError.message,
          },
        });

        return res.status(500).json({
          error:
            "Could not prepare root account",
          detail:
            updateError.message,
        });
      }

      const profile =
        await upsertProfileFromPayload(
          updatedUser.user,
          {
            name: rootName,
            role: "Super Admin",
            department:
              "Agricultural and Resource Economics",
            staffId: "ROOT",
            staffEmail:
              requestedEmail,
            title: "Super Admin",
            status: "active",
          }
        );

      const {
        data,
        error,
      } =
        await supabasePublic.auth.signInWithPassword(
          {
            email:
              requestedEmail,
            password:
              ROOT_SUPER_ADMIN_SESSION_PASSWORD,
          }
        );

      if (error) {
        await writeSecurityLog({
          req,
          action:
            "auth.root.session_failed",
          severity: "critical",
          metadata: {
            email:
              requestedEmail,
            error:
              error.message,
          },
        });

        return res.status(401).json({
          error:
            "Root session could not be created",
          detail:
            error.message,
        });
      }

      await writeSecurityLog({
        req,
        actor: {
          id: data.user.id,
          email: data.user.email,
        },
        action:
          "auth.root.success",
        severity: "critical",
      });

      return res.json(
        authPayload({
          session:
            data.session,
          user:
            data.user,
          profile,
        })
      );
    } catch (error) {
      console.error(
        "Root login failed",
        error
      );

      await writeSecurityLog({
        req,
        action:
          "auth.root.unhandled",
        severity: "critical",
        metadata: {
          error:
            error.message,
        },
      });

      return res.status(500).json({
        error:
          "Root login failed",
        detail:
          error.message,
      });
    }
  }
);

app.post(
  "/api/auth/root-password-reset-link",
  loginLimiter,
  async (req, res) => {
    try {
      if (missingEnv.length) {
        return res.status(503).json({
          error:
            "Backend Supabase environment is not configured",
          missingEnv,
        });
      }

      const parsed =
        rootResetLinkSchema.safeParse(
          req.body
        );

      if (!parsed.success) {
        return res.status(400).json({
          error:
            "Invalid root reset payload",
        });
      }

      const requestedEmail =
        String(
          parsed.data.email || ""
        )
          .trim()
          .toLowerCase();

      if (
        !timingSafeEqualString(
          requestedEmail,
          ROOT_SUPER_ADMIN_EMAIL
        )
      ) {
        await writeSecurityLog({
          req,
          action:
            "auth.root_reset.denied",
          severity: "critical",
          metadata: {
            email:
              requestedEmail ||
              "missing",
          },
        });

        return res.status(403).json({
          error:
            "This email is not authorized for root recovery",
        });
      }

      const authUser =
        await findAuthUserByEmail(
          requestedEmail
        );

      if (!authUser) {
        await writeSecurityLog({
          req,
          action:
            "auth.root_reset.missing_user",
          severity: "critical",
          metadata: {
            email:
              requestedEmail,
          },
        });

        return res.status(404).json({
          error:
            "Root account does not exist yet",
        });
      }

      if (
        gmailConfigured() &&
        parsed.data.redirectTo
      ) {
        const {
          data,
          error,
        } =
          await supabaseAdmin.auth.admin.generateLink(
            {
              type: "recovery",
              email:
                requestedEmail,
              options: {
                redirectTo:
                  parsed.data
                    .redirectTo,
              },
            }
          );

        if (
          error ||
          !data?.properties
            ?.action_link
        ) {
          await writeSecurityLog({
            req,
            action:
              "auth.root_reset.gmail_failed",
            severity: "critical",
            metadata: {
              email:
                requestedEmail,
              error:
                error?.message,
            },
          });

          return res.status(400).json({
            error:
              error?.message ||
              "Could not create root reset link",
          });
        }

        await sendGmailMail({
          to: requestedEmail,

          subject:
            "Reset your Nexaa root password",

          text:
            `Use this link to reset your Nexaa root password:\n\n` +
            `${data.properties.action_link}\n\n` +
            `This link expires soon. If you did not request this, review root access immediately.`,

          html: `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#020403;padding:32px 14px;font-family:Inter,Arial,sans-serif;color:#eafff3;">
              <tr>
                <td align="center">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:linear-gradient(145deg,rgba(12,24,18,.98),rgba(2,6,4,.98));border:1px solid rgba(0,255,136,.22);border-radius:24px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.5);">
                    <tr>
                      <td style="padding:30px 28px 18px;">
                        <p style="margin:0 0 14px;color:#00ff88;font-family:'Courier New',monospace;font-size:12px;letter-spacing:5px;font-weight:700;">&gt; ROOT_RECOVERY</p>

                        <h1 style="margin:0 0 10px;font-size:26px;line-height:1.15;color:#f5fff8;">
                          Reset root password
                        </h1>

                        <p style="margin:0;color:#9fb8aa;font-size:14px;line-height:1.65;">
                          A recovery link was requested for the Nexaa Super Admin control center.
                        </p>
                      </td>
                    </tr>

                    <tr>
                      <td style="padding:0 28px 28px;">
                        <a href="${htmlEscape(
                          data.properties
                            .action_link
                        )}" style="display:block;text-align:center;text-decoration:none;background:#00e982;color:#031107;border-radius:16px;padding:16px 18px;font-weight:800;letter-spacing:2px;">
                          RESET ROOT KEY
                        </a>

                        <p style="margin:20px 0 0;padding:14px 16px;border-radius:16px;background:rgba(255,193,7,.1);border:1px solid rgba(255,193,7,.26);color:#ffe7a0;font-size:13px;line-height:1.55;">
                          This link expires soon. If you did not request it, review root access immediately.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          `,
        });

        await writeSecurityLog({
          req,
          action:
            "auth.root_reset.requested",
          severity: "critical",
          metadata: {
            email:
              requestedEmail,
            delivery:
              "gmail",
          },
        });

        return res.json({
          ok: true,
          delivery: "gmail",
        });
      }

      const { error } =
        await supabasePublic.auth.resetPasswordForEmail(
          requestedEmail,
          {
            redirectTo:
              parsed.data
                .redirectTo,
          }
        );

      if (error) {
        await writeSecurityLog({
          req,
          action:
            "auth.root_reset.failed",
          severity: "critical",
          metadata: {
            email:
              requestedEmail,
            error:
              error.message,
          },
        });

        return res.status(400).json({
          error:
            error.message,
        });
      }

      await writeSecurityLog({
        req,
        action:
          "auth.root_reset.requested",
        severity: "critical",
        metadata: {
          email:
            requestedEmail,
          delivery:
            "email",
        },
      });

      return res.json({
        ok: true,
        delivery: "email",
      });
    } catch (error) {
      console.error(
        "Root reset failed",
        error
      );

      await writeSecurityLog({
        req,
        action:
          "auth.root_reset.unhandled",
        severity: "critical",
        metadata: {
          error:
            error.message,
        },
      });

      return res.status(500).json({
        error:
          "Root reset failed",
        detail:
          error.message,
      });
    }
  }
);

app.post(
  "/api/auth/login",
  loginLimiter,
  async (req, res) => {
    if (missingEnv.length) {
      return res.status(503).json({
        error:
          "Backend Supabase environment is not configured",
        missingEnv,
      });
    }

    const parsed =
      loginSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid login payload",
      });
    }

    const {
      data,
      error,
    } =
      await supabasePublic.auth.signInWithPassword(
        parsed.data
      );

    if (error) {
      await writeSecurityLog({
        req,
        action:
          "auth.login.failed",
        severity: "warning",
        metadata: {
          email:
            parsed.data.email,
        },
      });

      return res.status(401).json({
        error:
          "Invalid email or password",
      });
    }

    await writeSecurityLog({
      req,
      actor: {
        id: data.user.id,
        email: data.user.email,
      },
      action:
        "auth.login.success",
    });

    let profile =
      await findProfile(
        data.user.id
      );

    if (!profile) {
      profile =
        await upsertProfileFromPayload(
          data.user,
          {
            name:
              data.user.user_metadata
                ?.name ||
              data.user.email,

            role: "student",

            department:
              "Agricultural and Resource Economics",
          }
        );
    }

    return res.json(
      authPayload({
        session:
          data.session,
        user:
          data.user,
        profile,
      })
    );
  }
);

app.post(
  "/api/auth/check-email",
  emailCheckLimiter,
  async (req, res) => {
    if (missingEnv.length) {
      return res.status(503).json({
        error:
          "Backend Supabase environment is not configured",
        missingEnv,
      });
    }

    const parsed =
      emailSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid email payload",
      });
    }

    const email =
      parsed.data.email.toLowerCase();

    const {
      data: profile,
      error: profileError,
    } =
      await supabaseAdmin
        .from("profiles")
        .select("id,email")
        .eq("email", email)
        .maybeSingle();

    if (profileError) {
      return res.status(500).json({
        error:
          profileError.message,
      });
    }

    if (profile) {
      return res.json({
        exists: true,
      });
    }

    const {
      data: users,
      error: usersError,
    } =
      await supabaseAdmin.auth.admin.listUsers(
        {
          page: 1,
          perPage: 1000,
        }
      );

    if (usersError) {
      return res.status(500).json({
        error:
          usersError.message,
      });
    }

    const exists =
      Boolean(
        users?.users?.some(
          (user) =>
            String(
              user.email || ""
            ).toLowerCase() ===
            email
        )
      );

    return res.json({
      exists,
    });
  }
);

app.post(
  "/api/auth/signup",
  loginLimiter,
  async (req, res) => {
    if (missingEnv.length) {
      return res.status(503).json({
        error:
          "Backend Supabase environment is not configured",
        missingEnv,
      });
    }

    const parsed =
      signupSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid signup payload",
      });
    }

    const {
      email,
      password,
      profile,
    } = parsed.data;

    const profileError =
      publicSignupProfileError(
        profile
      );

    if (profileError) {
      await writeSecurityLog({
        req,
        action:
          "auth.signup.role_blocked",
        severity: "warning",
        metadata: {
          email,
          role:
            profile.role,
        },
      });

      return res.status(403).json({
        error:
          profileError,
      });
    }

    const {
      data,
      error,
    } =
      await supabasePublic.auth.signUp(
        {
          email,
          password,

          options: {
            emailRedirectTo:
              `${frontendUrl(
                req
              )}/#login`,

            data:
              authUserMetadata(
                profile
              ),
          },
        }
      );

    if (
      error ||
      !data.user
    ) {
      await writeSecurityLog({
        req,
        action:
          "auth.signup.failed",
        severity: "warning",
        metadata: {
          email,
          error:
            error?.message,
        },
      });

      return res.status(400).json({
        error:
          error?.message ||
          "Could not create account",
      });
    }

    const savedProfile =
      await upsertProfileFromPayload(
        data.user,
        profile
      );

    await writeSecurityLog({
      req,
      actor: {
        id: data.user.id,
        email:
          data.user.email,
      },
      action:
        "auth.signup.success",
    });

    return res.status(201).json(
      authPayload({
        session:
          data.session,

        user:
          data.user,

        profile:
          savedProfile,

        extra: {
          requiresEmailConfirmation:
            !data.session,
        },
      })
    );
  }
);

app.post(
  "/api/auth/google-complete",
  loginLimiter,
  async (req, res) => {
    if (missingEnv.length) {
      return res.status(503).json({
        error:
          "Backend Supabase environment is not configured",
        missingEnv,
      });
    }

    const parsed =
      googleCompleteSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      const issue =
        parsed.error.issues?.[0];

      const field =
        issue?.path?.join(".") ||
        "request";

      return res.status(400).json({
        error:
          `${field}: ${
            issue?.message ||
            "Invalid Google signup payload"
          }`,
      });
    }

    const profileError =
      publicSignupProfileError(
        parsed.data.profile
      );

    if (profileError) {
      await writeSecurityLog({
        req,
        action:
          "auth.google_signup.role_blocked",
        severity: "warning",
        metadata: {
          role:
            parsed.data.profile
              .role,
        },
      });

      return res.status(403).json({
        error:
          profileError,
      });
    }

    let googleProfile;

    try {
      googleProfile =
        await googleProfileFromToken(
          parsed.data
        );
    } catch (error) {
      await writeSecurityLog({
        req,
        action:
          "auth.google_signup.verify_failed",
        severity: "warning",
        metadata: {
          error:
            error.message,
        },
      });

      return res.status(401).json({
        error:
          "Google sign in failed. Please try again.",
      });
    }

    const email =
      String(
        googleProfile.email
      ).toLowerCase();

    const profilePayload = {
      ...parsed.data.profile,

      email,

      name:
        parsed.data.profile.name ||
        googleProfile.name ||
        email,
    };

    const password =
      parsed.data.password;

    let authUser =
      await findAuthUserByEmail(
        email
      );

    if (!authUser) {
      const {
        data,
        error,
      } =
        await supabaseAdmin.auth.admin.createUser(
          {
            email,
            password,
            email_confirm: true,

            user_metadata: {
              ...authUserMetadata(
                profilePayload
              ),

              provider: "google",

              picture:
                googleProfile.picture ||
                null,

              google_subject:
                googleProfile.sub ||
                null,
            },

            app_metadata: {
              role:
                normalizeRole(
                  profilePayload.role
                ),
            },
          }
        );

      if (
        error ||
        !data.user
      ) {
        await writeSecurityLog({
          req,
          action:
            "auth.google_signup.create_failed",
          severity: "warning",
          metadata: {
            email,
            error:
              error?.message,
          },
        });

        return res.status(400).json({
          error:
            error?.message ||
            "Could not create Google account",
        });
      }

      authUser =
        data.user;
    } else {
      const {
        data,
        error,
      } =
        await supabaseAdmin.auth.admin.updateUserById(
          authUser.id,
          {
            password,
            email_confirm: true,

            user_metadata: {
              ...(authUser.user_metadata ||
                {}),

              ...authUserMetadata(
                profilePayload
              ),

              provider: "google",

              picture:
                googleProfile.picture ||
                authUser.user_metadata
                  ?.picture ||
                null,

              google_subject:
                googleProfile.sub ||
                authUser.user_metadata
                  ?.google_subject ||
                null,
            },

            app_metadata: {
              ...(authUser.app_metadata ||
                {}),

              role:
                normalizeRole(
                  profilePayload.role
                ),
            },
          }
        );

      if (
        error ||
        !data.user
      ) {
        await writeSecurityLog({
          req,
          action:
            "auth.google_signup.update_failed",
          severity: "warning",
          metadata: {
            email,
            error:
              error?.message,
          },
        });

        return res.status(400).json({
          error:
            error?.message ||
            "Could not update Google account",
        });
      }

      authUser =
        data.user;
    }

    const savedProfile =
      await upsertProfileFromPayload(
        authUser,
        profilePayload
      );

    const {
      data: sessionData,
      error: sessionError,
    } =
      await supabasePublic.auth.signInWithPassword(
        {
          email,
          password,
        }
      );

    if (
      sessionError ||
      !sessionData.session
    ) {
      await writeSecurityLog({
        req,
        actor: {
          id:
            authUser.id,
          email,
        },
        action:
          "auth.google_signup.session_failed",
        severity: "warning",
        metadata: {
          error:
            sessionError?.message,
        },
      });

      return res.status(400).json({
        error:
          sessionError?.message ||
          "Could not start your session after Google sign in",
      });
    }

    await writeSecurityLog({
      req,
      actor: {
        id:
          authUser.id,
        email,
      },
      action:
        "auth.google_signup.completed",
    });

    return res.status(201).json(
      authPayload({
        session:
          sessionData.session,

        user:
          sessionData.user,

        profile:
          savedProfile,
      })
    );
  }
);

app.put(
  "/api/auth/profile",
  requireAuth,
  async (req, res) => {
    const parsed =
      profileSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid profile payload",
      });
    }

    const savedProfile =
      await upsertProfileFromPayload(
        req.user,
        parsed.data
      );

    await writeSecurityLog({
      req,
      actor:
        savedProfile,
      action:
        "auth.profile.updated",
    });

    return res.json({
      profile:
        frontendProfile(
          savedProfile,
          req.user
        ),
    });
  }
);

app.get(
  "/api/auth/me",
  requireAuth,
  async (req, res) => {
    return res.json({
      user:
        frontendUser(
          req.user
        ),

      profile:
        frontendProfile(
          req.profile,
          req.user
        ),
    });
  }
);

app.post(
  "/api/auth/request-otp",
  loginLimiter,
  async (req, res) => {
    if (missingEnv.length) {
      return res.status(503).json({
        error:
          "Backend Supabase environment is not configured",
        missingEnv,
      });
    }

    const parsed =
      emailSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid email payload",
      });
    }

    const recaptchaOk =
      await verifyRecaptchaToken(
        parsed.data
          .recaptchaToken,
        req.ip
      );

    if (!recaptchaOk) {
      await writeSecurityLog({
        req,
        action:
          "auth.recaptcha.failed",
        severity: "warning",
        metadata: {
          email:
            parsed.data.email,
        },
      });

      return res.status(400).json({
        error:
          "Complete the Google security check before continuing",
      });
    }

    if (gmailConfigured()) {
      const otp = String(
        Math.floor(
          100000 +
            Math.random() *
              900000
        )
      );

      const emailContent =
        brandedOtpEmail({
          email:
            parsed.data.email,
          otp,
        });

      gmailOtpStore.set(
        parsed.data.email.toLowerCase(),
        {
          otp,

          expiresAt:
            Date.now() +
            10 * 60 * 1000,

          used: false,
        }
      );

      await sendGmailMail({
        to:
          parsed.data.email,

        subject:
          `Nexaa verification code: ${otp}`,

        text:
          emailContent.text,

        html:
          emailContent.html,
      });

      await writeSecurityLog({
        req,
        action:
          "auth.gmail_otp.requested",
        metadata: {
          email:
            parsed.data.email,
        },
      });

      return res.json({
        ok: true,
        delivery: "gmail",
      });
    }

    const { error } =
      await supabasePublic.auth.signInWithOtp(
        {
          email:
            parsed.data.email,

          options: {
            shouldCreateUser:
              true,
          },
        }
      );

    if (error) {
      await writeSecurityLog({
        req,
        action:
          "auth.otp.failed",
        severity: "warning",
        metadata: {
          email:
            parsed.data.email,
          error:
            error.message,
        },
      });

      return res.status(400).json({
        error:
          error.message,
      });
    }

    await writeSecurityLog({
      req,
      action:
        "auth.otp.requested",
      metadata: {
        email:
          parsed.data.email,
      },
    });

    return res.json({
      ok: true,
      delivery: "email",
    });
  }
);

app.post(
  "/api/auth/verify-otp",
  loginLimiter,
  async (req, res) => {
    if (missingEnv.length) {
      return res.status(503).json({
        error:
          "Backend Supabase environment is not configured",
        missingEnv,
      });
    }

    const parsed =
      otpSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid OTP payload",
      });
    }

    if (gmailConfigured()) {
      const key =
        parsed.data.email.toLowerCase();

      const record =
        gmailOtpStore.get(
          key
        );

      if (
        !record ||
        record.used ||
        Date.now() >
          record.expiresAt ||
        parsed.data.token !==
          record.otp
      ) {
        await writeSecurityLog({
          req,
          action:
            "auth.gmail_otp.invalid",
          severity: "warning",
          metadata: {
            email:
              parsed.data.email,
          },
        });

        return res.status(401).json({
          error:
            "Invalid or expired OTP",
        });
      }

      record.used = true;

      gmailOtpStore.set(
        key,
        record
      );

      await writeSecurityLog({
        req,
        action:
          "auth.gmail_otp.verified",
        metadata: {
          email:
            parsed.data.email,
        },
      });

      return res.json({
        ok: true,
        delivery: "gmail",
      });
    }

    const {
      data,
      error,
    } =
      await supabasePublic.auth.verifyOtp(
        {
          email:
            parsed.data.email,

          token:
            parsed.data.token,

          type: "email",
        }
      );

    if (
      error ||
      !data.session
    ) {
      await writeSecurityLog({
        req,
        action:
          "auth.otp.invalid",
        severity: "warning",
        metadata: {
          email:
            parsed.data.email,
          error:
            error?.message,
        },
      });

      return res.status(401).json({
        error:
          "Invalid or expired OTP",
      });
    }

    await writeSecurityLog({
      req,
      actor: {
        id:
          data.user.id,
        email:
          data.user.email,
      },
      action:
        "auth.otp.verified",
    });

    return res.json(
      authPayload({
        session:
          data.session,
        user:
          data.user,
        profile: {},
      })
    );
  }
);

app.post(
  "/api/auth/complete-otp-signup",
  loginLimiter,
  async (req, res) => {
    if (missingEnv.length) {
      return res.status(503).json({
        error:
          "Backend Supabase environment is not configured",
        missingEnv,
      });
    }

    const parsed =
      completeOtpSignupSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid OTP signup payload",
      });
    }

    const profileError =
      publicSignupProfileError(
        parsed.data.profile
      );

    if (profileError) {
      await writeSecurityLog({
        req,
        action:
          "auth.otp_signup.role_blocked",
        severity: "warning",
        metadata: {
          email:
            parsed.data.email ||
            parsed.data.profile
              .email,

          role:
            parsed.data.profile
              .role,
        },
      });

      return res.status(403).json({
        error:
          profileError,
      });
    }

    if (
      !parsed.data.accessToken
    ) {
      const email =
        parsed.data.email ||
        parsed.data.profile.email;

      if (gmailConfigured()) {
        const otpRecord =
          gmailOtpStore.get(
            email.toLowerCase()
          );

        if (
          !otpRecord?.used ||
          Date.now() >
            otpRecord.expiresAt
        ) {
          await writeSecurityLog({
            req,
            action:
              "auth.gmail_otp_signup.unverified",
            severity: "warning",
            metadata: {
              email,
            },
          });

          return res.status(401).json({
            error:
              "Verify your email before creating this account",
          });
        }
      }

      const {
        data,
        error,
      } =
        await supabaseAdmin.auth.admin.createUser(
          {
            email,

            password:
              parsed.data.password,

            email_confirm:
              true,

            user_metadata:
              authUserMetadata(
                parsed.data.profile
              ),

            app_metadata: {
              role:
                normalizeRole(
                  parsed.data
                    .profile.role
                ),
            },
          }
        );

      if (
        error ||
        !data.user
      ) {
        await writeSecurityLog({
          req,
          action:
            "auth.gmail_otp_signup.failed",
          severity: "warning",
          metadata: {
            email,
            error:
              error?.message,
          },
        });

        return res.status(400).json({
          error:
            error?.message ||
            "Could not create account",
        });
      }

      const savedProfile =
        await upsertProfileFromPayload(
          data.user,
          parsed.data.profile
        );

      const {
        data: sessionData,
        error: sessionError,
      } =
        await supabasePublic.auth.signInWithPassword(
          {
            email,

            password:
              parsed.data.password,
          }
        );

      if (
        sessionError ||
        !sessionData.session
      ) {
        await writeSecurityLog({
          req,
          actor: {
            id:
              data.user.id,
            email:
              data.user.email,
          },
          action:
            "auth.gmail_otp_signup.session_failed",
          severity: "warning",
          metadata: {
            email,
            error:
              sessionError?.message,
          },
        });

        return res.status(201).json({
          session: null,

          user:
            frontendUser(
              data.user
            ),

          profile:
            frontendProfile(
              savedProfile,
              data.user
            ),

          requiresEmailConfirmation:
            false,
        });
      }

      await writeSecurityLog({
        req,
        actor: {
          id:
            data.user.id,
          email:
            data.user.email,
        },
        action:
          "auth.gmail_otp_signup.completed",
      });

      return res.status(201).json(
        authPayload({
          session:
            sessionData.session,

          user:
            sessionData.user,

          profile:
            savedProfile,

          extra: {
            requiresEmailConfirmation:
              false,
          },
        })
      );
    }

    const {
      accessToken,
      password,
      profile,
    } = parsed.data;

    const {
      data: userData,
      error: userError,
    } =
      await supabasePublic.auth.getUser(
        accessToken
      );

    if (
      userError ||
      !userData.user
    ) {
      return res.status(401).json({
        error:
          "Invalid signup session",
      });
    }

    const {
      error: passwordError,
    } =
      await supabaseAdmin.auth.admin.updateUserById(
        userData.user.id,
        {
          password,

          user_metadata: {
            ...(userData.user
              .user_metadata || {}),

            ...authUserMetadata(
              profile
            ),
          },

          app_metadata: {
            ...(userData.user
              .app_metadata || {}),

            role:
              normalizeRole(
                profile.role
              ),
          },
        }
      );

    if (passwordError) {
      await writeSecurityLog({
        req,
        action:
          "auth.otp_signup.password_failed",
        severity: "warning",
        metadata: {
          email:
            userData.user.email,
          error:
            passwordError.message,
        },
      });

      return res.status(400).json({
        error:
          "Could not finish account setup",
      });
    }

    const savedProfile =
      await upsertProfileFromPayload(
        userData.user,
        {
          ...profile,
          email:
            userData.user.email,
        }
      );

    await writeSecurityLog({
      req,
      actor: {
        id:
          userData.user.id,
        email:
          userData.user.email,
      },
      action:
        "auth.otp_signup.completed",
    });

    return res.status(201).json(
      authPayload({
        session: {
          access_token:
            accessToken,

          token_type:
            "bearer",
        },

        user:
          userData.user,

        profile:
          savedProfile,
      })
    );
  }
);

app.post(
  "/api/auth/password-reset-link",
  loginLimiter,
  async (req, res) => {
    if (missingEnv.length) {
      return res.status(503).json({
        error:
          "Backend Supabase environment is not configured",
        missingEnv,
      });
    }

    const parsed =
      resetLinkSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid reset-link payload",
      });
    }

    if (
      gmailConfigured() &&
      parsed.data.redirectTo
    ) {
      const {
        data,
        error,
      } =
        await supabaseAdmin.auth.admin.generateLink(
          {
            type: "recovery",

            email:
              parsed.data.email,

            options: {
              redirectTo:
                parsed.data
                  .redirectTo,
            },
          }
        );

      if (
        error ||
        !data?.properties
          ?.action_link
      ) {
        await writeSecurityLog({
          req,
          action:
            "auth.gmail_reset_link.failed",
          severity: "warning",
          metadata: {
            email:
              parsed.data.email,
            error:
              error?.message,
          },
        });

        return res.status(400).json({
          error:
            error?.message ||
            "Could not create reset link",
        });
      }

      await sendGmailMail({
        to:
          parsed.data.email,

        subject:
          "Reset your Nexaa password",

        text:
          `Use this link to reset your Nexaa password:\n\n` +
          `${data.properties.action_link}\n\n` +
          `This link expires soon.\n\n` +
          `If you did not request this, you can ignore this email.`,
      });

      await writeSecurityLog({
        req,
        action:
          "auth.gmail_reset_link.requested",
        metadata: {
          email:
            parsed.data.email,
        },
      });

      return res.json({
        ok: true,
        delivery: "gmail",
      });
    }

    const { error } =
      await supabasePublic.auth.resetPasswordForEmail(
        parsed.data.email,
        {
          redirectTo:
            parsed.data
              .redirectTo,
        }
      );

    if (error) {
      await writeSecurityLog({
        req,
        action:
          "auth.reset_link.failed",
        severity: "warning",
        metadata: {
          email:
            parsed.data.email,
          error:
            error.message,
        },
      });

      return res.status(400).json({
        error:
          error.message,
      });
    }

    await writeSecurityLog({
      req,
      action:
        "auth.reset_link.requested",
      metadata: {
        email:
          parsed.data.email,
      },
    });

    return res.json({
      ok: true,
      delivery: "email",
    });
  }
);

app.post(
  "/api/support",
  loginLimiter,
  async (req, res) => {
    const parsed =
      supportSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid support payload",
      });
    }

    // IMPORTANT:
    // No hardcoded admin email.
    // SUPPORT_ADMIN_EMAIL must exist in backend/.env.
    const to =
      process.env.SUPPORT_ADMIN_EMAIL;

    if (!to) {
      return res.status(503).json({
        error:
          "Support email is not configured on the server",
      });
    }

    try {
      let savedRequest =
        null;

      if (!missingEnv.length) {
        const {
          data: profile,
        } =
          await supabaseAdmin
            .from("profiles")
            .select("id")
            .eq(
              "email",
              parsed.data.email
                .toLowerCase()
            )
            .maybeSingle();

        const {
          data,
          error,
        } =
          await supabaseAdmin
            .from(
              "support_requests"
            )
            .insert({
              user_id:
                profile?.id ||
                null,

              email:
                parsed.data.email
                  .toLowerCase(),

              subject:
                `Support request from ${parsed.data.name}`,

              message:
                parsed.data.message,

              status:
                "open",
            })
            .select("*")
            .single();

        if (!error) {
          savedRequest =
            data;
        }
      }

      const sent =
        await sendGmailMail({
          to,

          subject:
            `Nexaa support request from ${parsed.data.name}`,

          replyTo:
            parsed.data.email,

          text: [
            "New Nexaa support request",
            "",
            `Name: ${parsed.data.name}`,
            `Email: ${parsed.data.email}`,
            "",
            "Message:",
            parsed.data.message,
          ].join("\n"),
        });

      if (!sent) {
        return res.status(503).json({
          error:
            "Gmail delivery is not configured",
        });
      }

      await writeSecurityLog({
        req,
        action:
          "support.gmail.sent",
        metadata: {
          email:
            parsed.data.email,

          supportRequestId:
            savedRequest?.id ||
            null,
        },
      });

      return res.json({
        ok: true,
        delivery: "gmail",
        supportRequest:
          savedRequest,
      });
    } catch (error) {
      await writeSecurityLog({
        req,
        action:
          "support.gmail.failed",
        severity: "warning",
        metadata: {
          email:
            parsed.data.email,
          error:
            error.message,
        },
      });

      return res.status(502).json({
        error:
          "Could not send support message",
      });
    }
  }
);

app.get(
  "/api/support/requests",
  requireAuth,
  requireRoles(
    "admin",
    "super_admin"
  ),
  async (_req, res) => {
        const { data, error } = await supabaseAdmin
      .from("support_requests")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    return res.json({
      requests: data || [],
    });
  }
);

app.get(
  "/api/admin/users",
  requireAuth,
  requireRoles("admin", "super_admin"),
  async (req, res) => {
    try {
      const { data: profiles, error } =
        await supabaseAdmin
          .from("profiles")
          .select("*")
          .order("created_at", {
            ascending: false,
          });

      if (error) {
        return res.status(500).json({
          error: error.message,
        });
      }

      return res.json({
        users: (profiles || []).map(
          (profile) =>
            frontendProfile(
              profile,
              {
                id: profile.id,
                email: profile.email,
              }
            )
        ),
      });
    } catch (error) {
      return res.status(500).json({
        error:
          "Could not load users",
        detail:
          error.message,
      });
    }
  }
);

app.patch(
  "/api/admin/users/:id",
  requireAuth,
  requireRoles(
    "admin",
    "super_admin"
  ),
  requireWritableMode,
  async (req, res) => {
    try {
      const userId =
        String(req.params.id || "").trim();

      if (!userId) {
        return res.status(400).json({
          error:
            "User ID is required",
        });
      }

      const parsed =
        adminUserUpdateSchema.safeParse(
          req.body
        );

      if (!parsed.success) {
        return res.status(400).json({
          error:
            "Invalid user update payload",
        });
      }

      const currentProfile =
        await findProfile(userId);

      if (!currentProfile) {
        return res.status(404).json({
          error:
            "User profile not found",
        });
      }

      const requestedRole =
        parsed.data.role
          ? normalizeRole(
              parsed.data.role
            )
          : currentProfile.role;

      if (
        requestedRole ===
          "super_admin" &&
        req.profile.role !==
          "super_admin"
      ) {
        return res.status(403).json({
          error:
            "Only a super admin can assign super admin",
        });
      }

      const status =
        parsed.data.status
          ? normalizeStatus(
              parsed.data.status
            )
          : currentProfile.status;

      const {
        data: updatedUser,
        error: userError,
      } =
        await supabaseAdmin.auth.admin.updateUserById(
          userId,
          {
            user_metadata: {
              ...(currentProfile || {}),
              name:
                parsed.data.name ||
                currentProfile.full_name,
              role:
                requestedRole,
              status,
            },

            app_metadata: {
              role:
                requestedRole,
              status,
            },
          }
        );

      if (userError) {
        return res.status(400).json({
          error:
            userError.message,
        });
      }

      const { data, error } =
        await supabaseAdmin
          .from("profiles")
          .update({
            full_name:
              parsed.data.name ||
              currentProfile.full_name,

            role:
              requestedRole,

            department:
              parsed.data.department ??
              currentProfile.department,

            staff_id:
              parsed.data.staffId ??
              currentProfile.staff_id,

            staff_email:
              parsed.data.staffEmail ??
              currentProfile.staff_email,

            title:
              parsed.data.title ??
              currentProfile.title,

            status,

            updated_at:
              new Date().toISOString(),
          })
          .eq("id", userId)
          .select("*")
          .single();

      if (error) {
        return res.status(400).json({
          error:
            error.message,
        });
      }

      await writeSecurityLog({
        req,
        actor:
          req.profile,
        action:
          "admin.user.updated",
        metadata: {
          targetUserId:
            userId,
          role:
            requestedRole,
          status,
        },
      });

      return res.json({
        user:
          frontendProfile(
            data,
            updatedUser
              ?.user || {
              id: userId,
              email:
                currentProfile.email,
            }
          ),
      });
    } catch (error) {
      console.error(
        "Admin user update failed",
        error
      );

      return res.status(500).json({
        error:
          "Could not update user",
        detail:
          error.message,
      });
    }
  }
);

app.delete(
  "/api/admin/users/:id",
  requireAuth,
  requireRoles(
    "admin",
    "super_admin"
  ),
  requireWritableMode,
  async (req, res) => {
    try {
      const userId =
        String(req.params.id || "").trim();

      if (!userId) {
        return res.status(400).json({
          error:
            "User ID is required",
        });
      }

      if (
        userId === req.user.id
      ) {
        return res.status(400).json({
          error:
            "You cannot delete your own account from this route",
        });
      }

      const targetProfile =
        await findProfile(userId);

      if (!targetProfile) {
        return res.status(404).json({
          error:
            "User profile not found",
        });
      }

      if (
        targetProfile.role ===
          "super_admin" &&
        req.profile.role !==
          "super_admin"
      ) {
        return res.status(403).json({
          error:
            "Only a super admin can remove a super admin",
        });
      }

      const {
        error: authDeleteError,
      } =
        await supabaseAdmin.auth.admin.deleteUser(
          userId
        );

      if (authDeleteError) {
        return res.status(400).json({
          error:
            authDeleteError.message,
        });
      }

      await writeSecurityLog({
        req,
        actor:
          req.profile,
        action:
          "admin.user.deleted",
        severity:
          targetProfile.role ===
          "super_admin"
            ? "critical"
            : "warning",
        metadata: {
          targetUserId:
            userId,
          email:
            targetProfile.email,
          role:
            targetProfile.role,
        },
      });

      return res.json({
        ok: true,
      });
    } catch (error) {
      console.error(
        "Admin user deletion failed",
        error
      );

      return res.status(500).json({
        error:
          "Could not delete user",
        detail:
          error.message,
      });
    }
  }
);

app.get(
  "/api/admin/staff",
  requireAuth,
  requireRoles(
    "admin",
    "super_admin"
  ),
  async (_req, res) => {
    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from("profiles")
        .select("*")
        .in("role", [
          "staff",
          "hod",
          "admin",
          "super_admin",
        ])
        .order("created_at", {
          ascending: false,
        });

    if (error) {
      return res.status(500).json({
        error:
          error.message,
      });
    }

    return res.json({
      staff: (data || []).map(
        frontendStaffId
      ),
    });
  }
);

app.patch(
  "/api/admin/staff/:id",
  requireAuth,
  requireRoles(
    "admin",
    "super_admin"
  ),
  requireWritableMode,
  async (req, res) => {
    const staffId =
      String(
        req.params.id || ""
      ).trim();

    const parsed =
      staffIdUpdateSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid staff ID payload",
      });
    }

    const target =
      await findProfile(
        staffId
      );

    if (!target) {
      return res.status(404).json({
        error:
          "Staff profile not found",
      });
    }

    const requestedCode =
      String(
        parsed.data.code || ""
      )
        .trim()
        .toUpperCase();

    if (
      requestedCode &&
      requestedCode ===
        STAFF_VERIFICATION_PHRASE
    ) {
      return res.status(400).json({
        error:
          "That value is reserved for verification",
      });
    }

    const { data, error } =
      await supabaseAdmin
        .from("profiles")
        .update({
          staff_id:
            requestedCode ||
            target.staff_id ||
            null,

          status:
            parsed.data.status
              ? normalizeStatus(
                  parsed.data.status
                )
              : target.status,

          updated_at:
            new Date().toISOString(),
        })
        .eq("id", staffId)
        .select("*")
        .single();

    if (error) {
      return res.status(400).json({
        error:
          error.message,
      });
    }

    await writeSecurityLog({
      req,
      actor:
        req.profile,
      action:
        "admin.staff.updated",
      metadata: {
        targetUserId:
          staffId,
        staffId:
          data.staff_id,
        status:
          data.status,
      },
    });

    return res.json({
      staff:
        frontendStaffId(
          data
        ),
    });
  }
);

app.get(
  "/api/admin/uploads",
  requireAuth,
  requireRoles(
    "admin",
    "super_admin",
    "hod"
  ),
  async (req, res) => {
    try {
      const [
        projectsResult,
        materialsResult,
      ] = await Promise.all([
        supabaseAdmin
          .from("projects")
          .select("*")
          .order("created_at", {
            ascending: false,
          }),

        supabaseAdmin
          .from("materials")
          .select("*")
          .order("created_at", {
            ascending: false,
          }),
      ]);

      if (
        projectsResult.error &&
        !isMissingRelationOrColumn(
          projectsResult.error
        )
      ) {
        return res.status(500).json({
          error:
            projectsResult.error
              .message,
        });
      }

      if (
        materialsResult.error &&
        !isMissingRelationOrColumn(
          materialsResult.error
        )
      ) {
        return res.status(500).json({
          error:
            materialsResult.error
              .message,
        });
      }

      const projects =
        projectsResult.data || [];

      const materials =
        materialsResult.data || [];

      const uploaderIds = [
        ...new Set(
          [
            ...projects,
            ...materials,
          ]
            .map(
              (row) =>
                row.uploaded_by
            )
            .filter(Boolean)
        ),
      ];

      let uploaderMap =
        new Map();

      if (
        uploaderIds.length
      ) {
        const {
          data: uploaders,
        } =
          await supabaseAdmin
            .from("profiles")
            .select(
              "id,full_name,email"
            )
            .in(
              "id",
              uploaderIds
            );

        uploaderMap =
          new Map(
            (uploaders || []).map(
              (profile) => [
                profile.id,
                profile,
              ]
            )
          );
      }

      return res.json({
        projects:
          projects.map(
            (row) =>
              frontendStaffUpload(
                row,
                "Project",
                uploaderMap.get(
                  row.uploaded_by
                ) || {}
              )
          ),

        materials:
          materials.map(
            (row) =>
              frontendStaffUpload(
                row,
                "Material",
                uploaderMap.get(
                  row.uploaded_by
                ) || {}
              )
          ),
      });
    } catch (error) {
      console.error(
        "Admin uploads failed",
        error
      );

      return res.status(500).json({
        error:
          "Could not load uploads",
        detail:
          error.message,
      });
    }
  }
);

app.patch(
  "/api/admin/uploads/:kind/:id/review",
  requireAuth,
  requireRoles(
    "admin",
    "super_admin",
    "hod"
  ),
  requireWritableMode,
  async (req, res) => {
    const kind =
      String(
        req.params.kind || ""
      ).toLowerCase();

    const table =
      kind === "project"
        ? "projects"
        : kind === "material"
        ? "materials"
        : null;

    if (!table) {
      return res.status(400).json({
        error:
          "Invalid upload type",
      });
    }

    const parsed =
      uploadReviewSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Invalid review payload",
      });
    }

    const uploadId =
      String(
        req.params.id || ""
      ).trim();

    const {
      data: existing,
      error: existingError,
    } =
      await supabaseAdmin
        .from(table)
        .select("*")
        .eq("id", uploadId)
        .single();

    if (existingError) {
      return res.status(404).json({
        error:
          existingError.message,
      });
    }

    const update = {
      status:
        parsed.data.status,

      review_comment:
        parsed.data.comment ||
        null,

      reviewed_at:
        new Date().toISOString(),

      reviewed_by:
        req.user.id,

      updated_at:
        new Date().toISOString(),
    };

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(table)
        .update(update)
        .eq("id", uploadId)
        .select("*")
        .single();

    if (error) {
      return res.status(400).json({
        error:
          error.message,
      });
    }

    await writeSecurityLog({
      req,
      actor:
        req.profile,
      action:
        "admin.upload.reviewed",
      metadata: {
        kind,
        uploadId,
        status:
          parsed.data.status,
        previousStatus:
          existing.status,
      },
    });

    return res.json({
      upload:
        frontendStaffUpload(
          data,
          kind ===
            "project"
            ? "Project"
            : "Material",
          req.profile
        ),
    });
  }
);
app.get(
  "/api/admin/root-settings",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    try {
      const settings =
        await loadRootSettingsRow();

      return res.json({
        settings:
          frontendRootSettings(
            settings
          ),
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

app.patch(
  "/api/admin/root-settings",
  requireAuth,
  requireRoles("super_admin"),
  requireWritableMode,
  async (req, res) => {
    try {
      const parsed =
        rootSettingsSchema.safeParse(
          req.body
        );

      if (!parsed.success) {
        return res.status(400).json({
          error:
            "Invalid root settings payload",
        });
      }

      const update = {
        ...parsed.data,
        updated_at:
          new Date().toISOString(),
        updated_by:
          req.user.id,
      };

      const {
        data,
        error,
      } =
        await supabaseAdmin
          .from(
            "admin_root_settings"
          )
          .update(update)
          .eq(
            "singleton_key",
            true
          )
          .select("*")
          .single();

      if (error) {
        return res.status(400).json({
          error:
            error.message,
        });
      }

      await writeSecurityLog({
        req,
        actor:
          req.profile,
        action:
          "admin.root_settings.updated",
        severity:
          "critical",
        metadata: {
          changedFields:
            Object.keys(
              parsed.data
            ),
        },
      });

      return res.json({
        settings:
          frontendRootSettings(
            data
          ),
      });
    } catch (error) {
      console.error(
        "Root settings update failed",
        error
      );

      return res.status(500).json({
        error:
          "Could not update root settings",
        detail:
          error.message,
      });
    }
  }
);

app.get(
  "/api/security/logs",
  requireAuth,
  requireRoles("super_admin"),
  async (req, res) => {
    try {
      const limit =
        Math.min(
          Number(
            req.query.limit
          ) || 80,
          250
        );

      const {
        data,
        error,
      } =
        await listSecurityLogs(
          limit
        );

      if (error) {
        return res.status(500).json({
          error:
            error.message,
        });
      }

      return res.json({
        logs:
          data || [],
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/security/status",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    try {
      await seedSecurityDefaults();

      const {
        data,
        error,
      } =
        await supabaseAdmin
          .from(
            "security_system_status"
          )
          .select("*")
          .eq(
            "singleton_key",
            true
          )
          .single();

      if (error) {
        return res.status(500).json({
          error:
            error.message,
        });
      }

      return res.json({
        status:
          data,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

app.patch(
  "/api/security/status",
  requireAuth,
  requireRoles("super_admin"),
  async (req, res) => {
    try {
      const parsed =
        securityStatusSchema.safeParse(
          req.body
        );

      if (!parsed.success) {
        return res.status(400).json({
          error:
            "Invalid security status payload",
        });
      }

      const update = {
        ...parsed.data,
        updated_at:
          new Date().toISOString(),
        updated_by:
          req.user.id,
      };

      const {
        data,
        error,
      } =
        await supabaseAdmin
          .from(
            "security_system_status"
          )
          .update(update)
          .eq(
            "singleton_key",
            true
          )
          .select("*")
          .single();

      if (error) {
        return res.status(400).json({
          error:
            error.message,
        });
      }

      await writeSecurityLog({
        req,
        actor:
          req.profile,
        action:
          "security.status.updated",
        severity:
          "critical",
        metadata: {
          mode:
            parsed.data.mode,
        },
      });

      return res.json({
        status:
          data,
      });
    } catch (error) {
      console.error(
        "Security status update failed",
        error
      );

      return res.status(500).json({
        error:
          "Could not update security status",
        detail:
          error.message,
      });
    }
  }
);

app.get(
  "/api/security/events",
  requireAuth,
  requireRoles(
    "admin",
    "super_admin"
  ),
  async (req, res) => {
    try {
      const limit =
        Math.min(
          Number(
            req.query.limit
          ) || 100,
          250
        );

      const {
        data,
        error,
      } =
        await supabaseAdmin
          .from(
            "security_logs"
          )
          .select("*")
          .order(
            "created_at",
            {
              ascending: false,
            }
          )
          .limit(limit);

      if (
        error &&
        isMissingRelationOrColumn(
          error
        )
      ) {
        return res.json({
          events: [],
        });
      }

      if (error) {
        return res.status(500).json({
          error:
            error.message,
        });
      }

      return res.json({
        events:
          data || [],
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/notifications",
  requireAuth,
  async (req, res) => {
    try {
      const role =
        notificationRoleForProfile(
          req.profile
        );

      const {
        data,
        error,
      } =
        await supabaseAdmin
          .from(
            "notifications"
          )
          .select("*")
          .or(
            `target_role.eq.${role},target_user_id.eq.${req.user.id}`
          )
          .order(
            "created_at",
            {
              ascending: false,
            }
          )
          .limit(50);

      if (
        error &&
        isMissingRelationOrColumn(
          error
        )
      ) {
        return res.json({
          notifications: [],
        });
      }

      if (error) {
        return res.status(500).json({
          error:
            error.message,
        });
      }

      return res.json({
        notifications:
          data || [],
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

app.patch(
  "/api/notifications/:id/read",
  requireAuth,
  async (req, res) => {
    try {
      const notificationId =
        String(
          req.params.id || ""
        ).trim();

      if (!notificationId) {
        return res.status(400).json({
          error:
            "Notification ID is required",
        });
      }

      const {
        data,
        error,
      } =
        await supabaseAdmin
          .from(
            "notifications"
          )
          .update({
            read_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            notificationId
          )
          .eq(
            "target_user_id",
            req.user.id
          )
          .select("*")
          .maybeSingle();

      if (
        error &&
        isMissingRelationOrColumn(
          error
        )
      ) {
        return res.json({
          ok: true,
        });
      }

      if (error) {
        return res.status(500).json({
          error:
            error.message,
        });
      }

      return res.json({
        ok: true,
        notification:
          data || null,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

app.get(
  "/api/dashboard",
  requireAuth,
  async (req, res) => {
    try {
      const role =
        normalizeRole(
          req.profile.role
        );

      if (
        [
          "admin",
          "super_admin",
        ].includes(role)
      ) {
        return res.json(
          await adminOverviewPayload(
            req
          )
        );
      }

      const [
        projectsResult,
        materialsResult,
        notificationsResult,
      ] =
        await Promise.all([
          supabaseAdmin
            .from("projects")
            .select("*")
            .order(
              "created_at",
              {
                ascending: false,
              }
            )
            .limit(50),

          supabaseAdmin
            .from(
              "academic_materials"
            )
            .select("*")
            .order(
              "created_at",
              {
                ascending: false,
              }
            )
            .limit(50),

          supabaseAdmin
            .from(
              "notifications"
            )
            .select("*")
            .eq(
              "target_user_id",
              req.user.id
            )
            .order(
              "created_at",
              {
                ascending: false,
              }
            )
            .limit(30),
        ]);

      if (
        projectsResult.error &&
        !isMissingRelationOrColumn(
          projectsResult.error
        )
      ) {
        throw projectsResult.error;
      }

      if (
        materialsResult.error &&
        !isMissingRelationOrColumn(
          materialsResult.error
        )
      ) {
        throw materialsResult.error;
      }

      if (
        notificationsResult.error &&
        !isMissingRelationOrColumn(
          notificationsResult.error
        )
      ) {
        throw notificationsResult.error;
      }

      const projects =
        projectsResult.data ||
        [];

      const materials =
        materialsResult.data ||
        [];

      const notifications =
        notificationsResult.data ||
        [];

      return res.json({
        profile:
          frontendProfile(
            req.profile,
            req.user
          ),

        projects:
          projects.map(
            (row) =>
              frontendStaffUpload(
                row,
                "Project",
                req.profile
              )
          ),

        materials:
          materials.map(
            (row) =>
              frontendStaffUpload(
                row,
                "Material",
                req.profile
              )
          ),

        notifications,

        stats: {
          projects:
            projects.length,

          materials:
            materials.length,

          notifications:
            notifications.length,
        },
      });
    } catch (error) {
      console.error(
        "Dashboard failed",
        error
      );

      return res.status(500).json({
        error:
          "Could not load dashboard",
        detail:
          error.message,
      });
    }
  }
);
async function securityCenterPayload() {
  await seedSecurityDefaults();

  const [
    statusResult,
    logsResult,
    alertsResult,
    threatsResult,
    monitoringResult,
    backupsResult,
    settingsResult,
    usersResult,
    projectsResult,
    materialsResult,
    filesResult,
  ] = await Promise.all([
    supabaseAdmin
      .from("security_system_status")
      .select("*")
      .eq("singleton_key", true)
      .maybeSingle(),

    listSecurityLogs(80),

    supabaseAdmin
      .from("security_alerts")
      .select("*")
      .order("created_at", {
        ascending: false,
      })
      .limit(30),

    supabaseAdmin
      .from("security_threats")
      .select("*")
      .order("threat_score", {
        ascending: false,
      })
      .limit(50),

    supabaseAdmin
      .from("security_monitoring_snapshots")
      .select("*")
      .order("created_at", {
        ascending: false,
      })
      .limit(1)
      .maybeSingle(),

    supabaseAdmin
      .from("security_backup_points")
      .select("*")
      .order("created_at", {
        ascending: false,
      })
      .limit(12),

    supabaseAdmin
      .from("security_settings")
      .select("*")
      .eq("singleton_key", true)
      .maybeSingle(),

    supabaseAdmin
      .from("profiles")
      .select("id", {
        count: "exact",
        head: true,
      }),

    supabaseAdmin
      .from("projects")
      .select("id", {
        count: "exact",
        head: true,
      }),

    supabaseAdmin
      .from("academic_materials")
      .select("id", {
        count: "exact",
        head: true,
      }),

    supabaseAdmin
      .from("protected_files")
      .select("id", {
        count: "exact",
        head: true,
      }),
  ]);

  const firstError = [
    statusResult.error,
    logsResult.error,
    alertsResult.error,
    threatsResult.error,
    monitoringResult.error,
    backupsResult.error,
    settingsResult.error,
  ].find(Boolean);

  if (firstError) {
    throw firstError;
  }

  return {
    status:
      frontendSecurityStatus(
        statusResult.data
      ),

    metrics: {
      serviceHealth:
        statusResult.data?.mode ===
        "LOCKDOWN"
          ? "Restricted"
          : "99.98%",

      auditEvents:
        logsResult.data?.length || 0,

      knownUsers:
        usersResult.count || 0,

      projects:
        projectsResult.count || 0,

      materials:
        materialsResult.count || 0,

      protectedFiles:
        filesResult.count || 0,

      activeThreats:
        (threatsResult.data || [])
          .filter((item) =>
            [
              "blocked",
              "challenged",
              "monitored",
            ].includes(
              item.status
            )
          ).length,

      blockedAttacks:
        (threatsResult.data || [])
          .filter(
            (item) =>
              item.status ===
              "blocked"
          )
          .reduce(
            (sum, item) =>
              sum +
              Number(
                item.request_count ||
                  0
              ),
            0
          ),

      openAlerts:
        (alertsResult.data || [])
          .filter(
            (item) =>
              item.status !==
              "resolved"
          ).length,
    },

    logs:
      (logsResult.data || []).map(
        frontendSecurityLog
      ),

    alerts:
      (alertsResult.data || []).map(
        frontendSecurityAlert
      ),

    threats:
      (threatsResult.data || []).map(
        frontendSecurityThreat
      ),

    monitoring:
      frontendSecuritySnapshot(
        monitoringResult.data
      ),

    backups:
      (backupsResult.data || []).map(
        frontendSecurityBackup
      ),

    settings:
      frontendSecuritySettings(
        settingsResult.data
      ),
  };
}

app.get(
  "/api/security/overview",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    try {
      res.json(
        await securityCenterPayload()
      );
    } catch (error) {
      const status =
        isMissingRelationOrColumn(
          error
        )
          ? 503
          : 500;

      res
        .status(status)
        .json({
          error:
            error.message,
        });
    }
  }
);

app.get(
  "/api/security/status",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    await seedSecurityDefaults();

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "security_system_status"
        )
        .select("*")
        .eq(
          "singleton_key",
          true
        )
        .single();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    res.json({
      status:
        frontendSecurityStatus(
          data
        ),
    });
  }
);

app.patch(
  "/api/security/status",
  requireAuth,
  requireRoles("super_admin"),
  async (req, res) => {
    const parsed =
      statusSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid status payload",
        });
    }

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "security_system_status"
        )
        .upsert(
          {
            singleton_key:
              true,

            ...parsed.data,

            changed_by:
              req.profile.id,

            changed_at:
              new Date().toISOString(),
          },
          {
            onConflict:
              "singleton_key",
          }
        )
        .select("*")
        .single();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    await supabaseAdmin
      .from("maintenance_state")
      .upsert(
        {
          id: true,

          enabled:
            [
              "LOCKDOWN",
              "MAINTENANCE",
            ].includes(
              parsed.data.mode
            ),

          message:
            parsed.data.mode ===
            "LOCKDOWN"
              ? "The archive is temporarily restricted by Super Admin security controls."
              : parsed.data.mode ===
                "MAINTENANCE"
              ? parsed.data.reason ||
                "The archive is under supervised maintenance."
              : "The archive is available.",

          updated_by:
            req.profile.id,
        },
        {
          onConflict: "id",
        }
      );

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        `security.mode.${parsed.data.mode.toLowerCase()}`,

      severity:
        parsed.data.mode ===
        "NORMAL"
          ? "info"
          : "critical",
    });

    if (
      parsed.data.mode ===
      "LOCKDOWN"
    ) {
      await createAlert({
        title:
          "Emergency lockdown enabled",

        severity:
          "critical",

        metadata: {
          actor:
            req.profile.email,
        },
      });
    }

    res.json({
      status:
        frontendSecurityStatus(
          data
        ),
    });
  }
);

app.get(
  "/api/security/threats",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    await seedSecurityDefaults();

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "security_threats"
        )
        .select("*")
        .order(
          "threat_score",
          {
            ascending: false,
          }
        )
        .limit(100);

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    res.json({
      threats:
        (data || []).map(
          frontendSecurityThreat
        ),
    });
  }
);

app.get(
  "/api/security/monitoring",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    await seedSecurityDefaults();

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "security_monitoring_snapshots"
        )
        .select("*")
        .order(
          "created_at",
          {
            ascending: false,
          }
        )
        .limit(1)
        .maybeSingle();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    res.json({
      monitoring:
        frontendSecuritySnapshot(
          data
        ),
    });
  }
);

app.get(
  "/api/security/backups",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    await seedSecurityDefaults();

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "security_backup_points"
        )
        .select("*")
        .order(
          "created_at",
          {
            ascending: false,
          }
        )
        .limit(50);

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    res.json({
      backups:
        (data || []).map(
          frontendSecurityBackup
        ),
    });
  }
);

app.get(
  "/api/security/settings",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    await seedSecurityDefaults();

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "security_settings"
        )
        .select("*")
        .eq(
          "singleton_key",
          true
        )
        .maybeSingle();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    res.json({
      settings:
        frontendSecuritySettings(
          data
        ),
    });
  }
);

app.patch(
  "/api/security/alerts/:id/status",
  requireAuth,
  requireRoles("super_admin"),
  async (req, res) => {
    const parsed =
      alertStatusSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid alert status payload",
        });
    }

    const updatePayload = {
      status:
        parsed.data.status,

      acknowledged_by:
        [
          "acknowledged",
          "investigating",
          "resolved",
        ].includes(
          parsed.data.status
        )
          ? req.profile.id
          : null,

      acknowledged_at:
        [
          "acknowledged",
          "investigating",
          "resolved",
        ].includes(
          parsed.data.status
        )
          ? new Date().toISOString()
          : null,
    };

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from("security_alerts")
        .update(
          updatePayload
        )
        .eq(
          "id",
          req.params.id
        )
        .select("*")
        .single();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        `security.alert.${parsed.data.status}`,

      metadata: {
        alertId:
          req.params.id,
      },
    });

    res.json({
      alert:
        frontendSecurityAlert(
          data
        ),
    });
  }
);

app.patch(
  "/api/admin/profiles/:id/status",
  requireAuth,
  requireRoles(
    "hod",
    "admin",
    "super_admin"
  ),
  async (req, res) => {
    const parsed =
      profileStatusSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid profile status payload",
        });
    }

    const {
      data: target,
      error: targetError,
    } =
      await supabaseAdmin
        .from("profiles")
        .select("*")
        .eq(
          "id",
          req.params.id
        )
        .single();

    if (
      targetError ||
      !target
    ) {
      return res
        .status(404)
        .json({
          error:
            "Profile not found",
        });
    }

    if (
      target.role ===
      "super_admin"
    ) {
      await writeSecurityLog({
        req,
        actor:
          req.profile,

        action:
          "profile.super_admin_status.denied",

        severity:
          "critical",

        metadata: {
          target:
            target.email,
        },
      });

      return res
        .status(403)
        .json({
          error:
            "Super Admin status can only be controlled by root policy",
        });
    }

    if (
      ["admin", "hod"].includes(
        target.role
      ) &&
      req.profile.role !==
        "super_admin"
    ) {
      return res
        .status(403)
        .json({
          error:
            "Only Super Admin can change elevated account status",
        });
    }

    if (
      target.role ===
        "staff" &&
      ![
        "hod",
        "super_admin",
      ].includes(
        req.profile.role
      )
    ) {
      if (
        parsed.data.status ===
          "active" &&
        target.status ===
          "pending"
      ) {
        return res
          .status(403)
          .json({
            error:
              "Only HOD or Super Admin can approve staff accounts",
          });
      }
    }

    const updatePayload = {
      status:
        parsed.data.status,

      updated_at:
        new Date().toISOString(),
    };

    if (
      parsed.data.status ===
        "active" &&
      target.role ===
        "staff" &&
      (
        !target.staff_id ||
        String(
          target.staff_id
        ).startsWith(
          "PENDING-"
        )
      )
    ) {
      updatePayload.staff_id =
        await generateUniqueStaffId();
    }

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from("profiles")
        .update(
          updatePayload
        )
        .eq(
          "id",
          req.params.id
        )
        .select("*")
        .single();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    await supabaseAdmin.auth.admin.updateUserById(
      req.params.id,
      {
        app_metadata: {
          role:
            data.role,

          status:
            data.status,
        },
      }
    );

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        `profile.${data.role}.${parsed.data.status}`,

      metadata: {
        target:
          data.email,

        comment:
          parsed.data
            .reviewComment ||
          "",
      },
    });

    res.json({
      profile:
        frontendProfile(
          data
        ),
    });
  }
);

app.patch(
  "/api/admin/profiles/:id/role",
  requireAuth,
  requireRoles("super_admin"),
  async (req, res) => {
    const parsed =
      profileRoleSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid profile role payload",
        });
    }

    const nextRole =
      parsed.data.role;

    const {
      data: target,
      error: targetError,
    } =
      await supabaseAdmin
        .from("profiles")
        .select("*")
        .eq(
          "id",
          req.params.id
        )
        .single();

    if (
      targetError ||
      !target
    ) {
      return res
        .status(404)
        .json({
          error:
            "Profile not found",
        });
    }

    if (
      target.role ===
      "super_admin"
    ) {
      await writeSecurityLog({
        req,
        actor:
          req.profile,

        action:
          "profile.super_admin_role.denied",

        severity:
          "critical",

        metadata: {
          target:
            target.email,
        },
      });

      return res
        .status(403)
        .json({
          error:
            "Super Admin role cannot be changed here",
        });
    }

    if (
      target.role ===
      "student"
    ) {
      return res
        .status(400)
        .json({
          error:
            "Students cannot be promoted directly to Admin. They must register as staff first.",
        });
    }

    if (
      nextRole ===
        "admin" &&
      target.status !==
        "active"
    ) {
      return res
        .status(400)
        .json({
          error:
            "Approve this staff account before promoting it to Admin",
        });
    }

    if (
      target.role ===
      nextRole
    ) {
      return res.json({
        profile:
          frontendProfile(
            target
          ),
      });
    }

    const updatePayload = {
      role:
        nextRole,

      updated_at:
        new Date().toISOString(),
    };

    if (
      !target.staff_id ||
      String(
        target.staff_id
      ).startsWith(
        "PENDING-"
      )
    ) {
      updatePayload.staff_id =
        await generateUniqueStaffId();
    }

    if (
      !target.staff_email
    ) {
      updatePayload.staff_email =
        target.email;
    }

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from("profiles")
        .update(
          updatePayload
        )
        .eq(
          "id",
          req.params.id
        )
        .select("*")
        .single();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    const authUpdate =
      await supabaseAdmin.auth.admin.updateUserById(
        req.params.id,
        {
          app_metadata: {
            role:
              data.role,

            status:
              data.status,
          },
        }
      );

    if (authUpdate.error) {
      return res
        .status(500)
        .json({
          error:
            authUpdate.error
              .message,
        });
    }

    await supabaseAdmin
      .from("notifications")
      .insert({
        title:
          nextRole ===
          "admin"
            ? "Admin access granted"
            : "Admin access updated",

        body:
          nextRole ===
          "admin"
            ? "Your account has been promoted to Operations Admin."
            : "Your account role has been updated by Super Admin.",

        target_role:
          data.role,

        target_user_id:
          data.id,

        created_by:
          req.profile.id,
      });

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        `profile.role.${target.role}_to_${nextRole}`,

      severity:
        nextRole ===
        "admin"
          ? "high"
          : "warning",

      metadata: {
        target:
          data.email,

        previousRole:
          target.role,

        nextRole,

        reason:
          parsed.data.reason ||
          "",
      },
    });

    res.json({
      profile:
        frontendProfile(
          data
        ),
    });
  }
);

app.patch(
  "/api/maintenance",
  requireAuth,
  requireRoles("super_admin"),
  async (req, res) => {
    const parsed =
      maintenanceSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid maintenance payload",
        });
    }

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from("maintenance_state")
        .upsert(
          {
            id: true,

            enabled:
              parsed.data
                .enabled,

            message:
              parsed.data
                .message,

            updated_by:
              req.profile.id,

            updated_at:
              new Date().toISOString(),
          },
          {
            onConflict: "id",
          }
        )
        .select("*")
        .single();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        parsed.data.enabled
          ? "maintenance.enabled"
          : "maintenance.disabled",
    });

    res.json(data);
  }
);

app.get(
  "/api/student/archive",
  requireAuth,
  async (req, res) => {
    const projectsQuery =
      () =>
        supabaseAdmin
          .from("projects")
          .select(
            "id,title,abstract,category,year,level,authors,supervisor,department,file_path,status,created_at,book_id,cabinet,archive_row,archive_column,protected_file_id"
          )
          .eq(
            "status",
            "approved"
          )
          .order("year", {
            ascending: false,
          })
          .order(
            "created_at",
            {
              ascending: false,
            }
          );

    const materialsQuery =
      (
        includeProtectedFile = true
      ) =>
        supabaseAdmin
          .from(
            "academic_materials"
          )
          .select(
            includeProtectedFile
              ? "id,title,course_code,course_title,level,material_type,year,department,file_path,protected_file_id,status,created_at"
              : "id,title,course_code,course_title,level,material_type,year,department,file_path,status,created_at"
          )
          .eq(
            "status",
            "approved"
          )
          .order(
            "level",
            {
              ascending: true,
            }
          )
          .order(
            "course_code",
            {
              ascending: true,
            }
          );

    const savedQuery =
      () =>
        supabaseAdmin
          .from("saved_items")
          .select(
            "id,project_id,material_id,created_at"
          )
          .eq(
            "user_id",
            req.profile.id
          )
          .order(
            "created_at",
            {
              ascending: false,
            }
          );

    const notificationsQuery =
      () =>
        supabaseAdmin
          .from(
            "notifications"
          )
          .select(
            "id,title,body,target_role,target_user_id,created_at"
          )
          .or(
            `target_user_id.eq.${req.profile.id},target_role.eq.${req.profile.role}`
          )
          .order(
            "created_at",
            {
              ascending: false,
            }
          )
          .limit(40);

    let [
      projectsResult,
      materialsResult,
      savedResult,
      notificationsResult,
    ] =
      await Promise.all([
        projectsQuery(),
        materialsQuery(true),
        savedQuery(),
        notificationsQuery(),
      ]);

    if (
      materialsResult.error &&
      isMissingRelationOrColumn(
        materialsResult.error
      )
    ) {
      materialsResult =
        await materialsQuery(
          false
        );

      if (
        !materialsResult.error
      ) {
        materialsResult.data =
          (
            materialsResult.data ||
            []
          ).map(
            (row) => ({
              ...row,
              protected_file_id:
                null,
            })
          );
      }
    }

    const firstError =
      projectsResult.error ||
      materialsResult.error ||
      savedResult.error ||
      notificationsResult.error;

    if (firstError) {
      return res
        .status(500)
        .json({
          error:
            firstError.message,
        });
    }

    res.json({
      profile:
        frontendProfile(
          req.profile,
          req.user
        ),

      projects:
        (
          projectsResult.data ||
          []
        ).map(
          frontendProject
        ),

      materials:
        (
          materialsResult.data ||
          []
        ).map(
          frontendMaterial
        ),

      savedIds:
        (
          savedResult.data ||
          []
        )
          .map(
            frontendSavedId
          )
          .filter(Boolean),

      notifications:
        notificationsResult.data ||
        [],
    });
  }
);

app.post(
  "/api/student/saved",
  requireAuth,
  async (req, res) => {
    const parsed =
      saveResourceSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid saved resource payload",
        });
    }

    const row = {
      user_id:
        req.profile.id,

      project_id:
        parsed.data
          .resourceType ===
        "project"
          ? parsed.data
              .resourceId
          : null,

      material_id:
        parsed.data
          .resourceType ===
        "material"
          ? parsed.data
              .resourceId
          : null,
    };

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from("saved_items")
        .upsert(
          row,
          {
            onConflict:
              parsed.data
                .resourceType ===
              "project"
                ? "user_id,project_id"
                : "user_id,material_id",
          }
        )
        .select(
          "id,project_id,material_id,created_at"
        )
        .single();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    res
      .status(201)
      .json({
        savedId:
          frontendSavedId(
            data
          ),

        saved: true,
      });
  }
);

app.delete(
  "/api/student/saved/:resourceType/:resourceId",
  requireAuth,
  async (req, res) => {
    const parsed =
      saveResourceSchema.safeParse(
        req.params
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid saved resource path",
        });
    }

    const column =
      parsed.data
        .resourceType ===
      "project"
        ? "project_id"
        : "material_id";

    const { error } =
      await supabaseAdmin
        .from("saved_items")
        .delete()
        .eq(
          "user_id",
          req.profile.id
        )
        .eq(
          column,
          parsed.data
            .resourceId
        );

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    res.json({
      savedId:
        `${parsed.data.resourceType}:${parsed.data.resourceId}`,

      saved: false,
    });
  }
);

app.get(
  "/api/staff/dashboard",
  requireAuth,
  requireRoles(
    "staff",
    "hod",
    "admin",
    "super_admin"
  ),
  async (req, res) => {
    const manager =
      canManageDepartment(
        req.profile
      );

    const profileQuery =
      supabaseAdmin
        .from("profiles")
        .select(
          "id,email,full_name,role,status,department,staff_id,staff_email,title,updated_at"
        )
        .in("role", [
          "staff",
          "hod",
        ])
        .order(
          "updated_at",
          {
            ascending: false,
          }
        );

    if (!manager) {
      profileQuery.eq(
        "id",
        req.profile.id
      );
    } else if (
      req.profile.department
    ) {
      profileQuery.eq(
        "department",
        req.profile.department
      );
    }

    const projectQuery =
      supabaseAdmin
        .from("projects")
        .select(
          "id,title,category,department,status,review_comment,reviewed_by,reviewed_at,file_path,protected_file_id,uploaded_by,created_at"
        )
        .order(
          "created_at",
          {
            ascending: false,
          }
        )
        .limit(80);

    const materialQuery =
      supabaseAdmin
        .from(
          "academic_materials"
        )
        .select(
          "id,title,course_code,course_title,level,material_type,department,status,review_comment,reviewed_by,reviewed_at,file_path,protected_file_id,uploaded_by,created_at"
        )
        .order(
          "created_at",
          {
            ascending: false,
          }
        )
        .limit(80);

    if (!manager) {
      projectQuery.eq(
        "uploaded_by",
        req.profile.id
      );

      materialQuery.eq(
        "uploaded_by",
        req.profile.id
      );
    } else if (
      req.profile.department
    ) {
      projectQuery.eq(
        "department",
        req.profile.department
      );

      materialQuery.eq(
        "department",
        req.profile.department
      );
    }

    const [
      profilesResult,
      projectsResult,
      materialsResult,
    ] =
      await Promise.all([
        profileQuery,
        projectQuery,
        materialQuery,
      ]);

    const firstError =
      profilesResult.error ||
      projectsResult.error ||
      materialsResult.error;

    if (firstError) {
      return res
        .status(500)
        .json({
          error:
            firstError.message,
        });
    }

    const staffProfiles =
      profilesResult.data ||
      [];

    const uploaderMap =
      new Map(
        staffProfiles.map(
          (profile) => [
            profile.id,
            profile,
          ]
        )
      );

    if (
      !uploaderMap.has(
        req.profile.id
      )
    ) {
      uploaderMap.set(
        req.profile.id,
        req.profile
      );
    }

    const uploads = [
      ...(
        projectsResult.data ||
        []
      ).map(
        (row) =>
          frontendStaffUpload(
            row,
            "Project",
            uploaderMap.get(
              row.uploaded_by
            )
          )
      ),

      ...(
        materialsResult.data ||
        []
      ).map(
        (row) =>
          frontendStaffUpload(
            row,
            "Material",
            uploaderMap.get(
              row.uploaded_by
            )
          )
      ),
    ].sort(
      (a, b) =>
        new Date(
          b.at || 0
        ) -
        new Date(
          a.at || 0
        )
    );

    res.json({
      profile:
        frontendProfile(
          req.profile,
          req.user
        ),

      staff:
        staffProfiles.map(
          (profile) =>
            frontendProfile(
              profile
            )
        ),

      uploads,
    });
  }
);

app.patch(
  "/api/reviews/uploads",
  requireAuth,
  requireRoles(
    "hod",
    "admin",
    "super_admin"
  ),
  requireWritableMode,
  async (req, res) => {
    const parsed =
      reviewUploadSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid review payload",
        });
    }

    const {
      resourceType,
      resourceId,
      decision,
    } =
      parsed.data;

    const comment =
      String(
        parsed.data.comment ||
          ""
      ).trim();

    if (
      decision ===
        "rejected" &&
      comment.length < 4
    ) {
      return res
        .status(400)
        .json({
          error:
            "A rejection comment is required",
        });
    }

    const table =
      resourceType ===
      "project"
        ? "projects"
        : "academic_materials";

    const {
      data: current,
      error: currentError,
    } =
      await supabaseAdmin
        .from(table)
        .select("*")
        .eq(
          "id",
          resourceId
        )
        .single();

    if (
      currentError ||
      !current
    ) {
      return res
        .status(404)
        .json({
          error:
            "Upload not found",
        });
    }

    if (
      req.profile.role ===
        "hod" &&
      req.profile.department &&
      current.department &&
      current.department !==
        req.profile.department
    ) {
      return res
        .status(403)
        .json({
          error:
            "This upload belongs to another department",
        });
    }

    const reviewComment =
      comment ||
      (
        decision ===
        "approved"
          ? "Approved for student access."
          : "Rejected. Please update and resubmit."
      );

    const updates = {
      status:
        decision,

      review_comment:
        reviewComment,

      reviewed_by:
        req.profile.id,

      reviewed_at:
        new Date().toISOString(),

      updated_at:
        new Date().toISOString(),
    };

    const {
      data: reviewed,
      error: reviewError,
    } =
      await supabaseAdmin
        .from(table)
        .update(updates)
        .eq(
          "id",
          resourceId
        )
        .select("*")
        .single();

    if (reviewError) {
      return res
        .status(500)
        .json({
          error:
            reviewError.message,
        });
    }

    const protectedFileId =
      reviewed.protected_file_id ||
      null;

    if (protectedFileId) {
      const {
        error: fileError,
      } =
        await supabaseAdmin
          .from(
            "protected_files"
          )
          .update({
            status:
              decision,
          })
          .eq(
            "id",
            protectedFileId
          );

      if (fileError) {
        return res
          .status(500)
          .json({
            error:
              fileError.message,
          });
      }
    } else if (
      reviewed.file_path
    ) {
      await supabaseAdmin
        .from(
          "protected_files"
        )
        .update({
          status:
            decision,
        })
        .eq(
          "storage_path",
          reviewed.file_path
        );
    }

    const uploaderId =
      reviewed.uploaded_by ||
      null;

    const {
      data: uploader,
    } = uploaderId
      ? await supabaseAdmin
          .from("profiles")
          .select("*")
          .eq(
            "id",
            uploaderId
          )
          .maybeSingle()
      : {
          data: null,
        };

    if (uploader) {
      await supabaseAdmin
        .from("notifications")
        .insert({
          title:
            decision ===
            "approved"
              ? "Upload approved"
              : "Upload rejected",

          body:
            `${
              reviewed.title ||
              "Your upload"
            }: ${reviewComment}`,

          target_role:
            notificationRoleForProfile(
              uploader
            ),

          target_user_id:
            uploader.id,

          created_by:
            req.profile.id,
        });
    }

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        `upload.${resourceType}.${decision}`,

      metadata: {
        resourceId,

        title:
          reviewed.title,

        uploader:
          uploader?.email ||
          null,

        comment:
          reviewComment,
      },
    });

    res.json({
      upload:
        frontendStaffUpload(
          reviewed,
          resourceType ===
          "project"
            ? "Project"
            : "Material",
          uploader || {}
        ),
    });
  }
);

app.post(
  "/api/notifications",
  requireAuth,
  requireRoles(
    "admin",
    "super_admin"
  ),
  async (req, res) => {
    const parsed =
      notificationSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid notification payload",
        });
    }

    const roles =
      parsed.data
        .targetRole ===
      "all"
        ? [
            "student",
            "staff",
            "hod",
            "admin",
            "super_admin",
          ]
        : [
            parsed.data
              .targetRole,
          ];

    const rows =
      roles.map(
        (role) => ({
          title:
            parsed.data
              .title,

          body:
            parsed.data
              .body,

          target_role:
            role,

          created_by:
            req.profile.id,
        })
      );

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from("notifications")
        .insert(rows)
        .select("*");

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        "notification.sent",

      metadata: {
        targetRole:
          parsed.data
            .targetRole,
      },
    });

    res
      .status(201)
      .json({
        notifications:
          data,
      });
  }
);

app.get(
  "/api/security/logs",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    const {
      data,
      error,
    } =
      await listSecurityLogs(
        100
      );

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    res.json({
      logs:
        (data || []).map(
          frontendSecurityLog
        ),
    });
  }
);

app.get(
  "/api/security/alerts",
  requireAuth,
  requireRoles("super_admin"),
  async (_req, res) => {
    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from("security_alerts")
        .select("*")
        .order(
          "created_at",
          {
            ascending: false,
          }
        )
        .limit(50);

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    res.json({
      alerts:
        (data || []).map(
          frontendSecurityAlert
        ),
    });
  }
);

app.post(
  "/api/files",
  requireAuth,
  requireRoles(
    "staff",
    "hod",
    "admin",
    "super_admin"
  ),
  requireWritableMode,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({
          error:
            "Missing file",
        });
    }

    const parsed =
      uploadMetadataSchema.safeParse(
        req.body
      );

    if (!parsed.success) {
      return res
        .status(400)
        .json({
          error:
            "Invalid upload metadata",
        });
    }

    const meta =
      parsed.data;

    const extension =
      path.extname(
        req.file.originalname
      ).toLowerCase();

    const storageName =
      `${crypto.randomUUID()}${extension}`;

    const storagePath =
      path.join(
        uploadRoot,
        storageName
      );

    fs.renameSync(
      req.file.path,
      storagePath
    );

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "protected_files"
        )
        .insert({
          owner_id:
            req.profile.id,

          title:
            meta.title ||
            req.file
              .originalname,

          file_name:
            req.file
              .originalname,

          original_name:
            req.file
              .originalname,

          storage_path:
            storageName,

          mime_type:
            req.file.mimetype,

          file_size:
            req.file.size,
        })
        .select("*")
        .single();

    if (error) {
      return res
        .status(500)
        .json({
          error:
            error.message,
        });
    }

    let archiveRecord =
      null;

    if (
      (
        meta.kind ||
        "Project"
      ) ===
      "Project"
    ) {
      const projectInsert =
        await supabaseAdmin
          .from("projects")
          .insert({
            title:
              meta.title ||
              req.file
                .originalname,

            abstract:
              meta.abstract ||
              null,

            category:
              meta.category ||
              "FYP",

            year:
              meta.year ||
              new Date().getFullYear(),

            authors:
              meta.authors
                ? meta.authors
                    .split(",")
                    .map(
                      (item) =>
                        item.trim()
                    )
                    .filter(Boolean)
                : [],

            supervisor:
              meta.supervisor ||
              null,

            department:
              req.profile
                .department ||
              null,

            file_path:
              storageName,

            protected_file_id:
              data.id,

            book_id:
              meta.bookId ||
              null,

            cabinet:
              meta.cabinet ||
              null,

            archive_row:
              meta.row ||
              null,

            archive_column:
              meta.column ||
              null,

            uploaded_by:
              req.profile.id,

            status:
              "pending_review",
          })
          .select("*")
          .single();

      if (
        !projectInsert.error
      ) {
        archiveRecord = {
          type:
            "project",

          ...frontendProject(
            projectInsert.data
          ),
        };
      }
    } else {
      const materialInsert =
        await supabaseAdmin
          .from(
            "academic_materials"
          )
          .insert({
            title:
              meta.title ||
              meta.courseTitle ||
              req.file
                .originalname,

            course_code:
              meta.courseCode ||
              "ARE",

            course_title:
              meta.courseTitle ||
              meta.title ||
              req.file
                .originalname,

            level:
              meta.level ||
              "400L",

            material_type:
              materialTypeToDb(
                meta.materialType
              ),

            year:
              meta.year ||
              new Date().getFullYear(),

            department:
              req.profile
                .department ||
              null,

            file_path:
              storageName,

            protected_file_id:
              data.id,

            uploaded_by:
              req.profile.id,

            status:
              "pending_review",
          })
          .select("*")
          .single();

      if (
        !materialInsert.error
      ) {
        archiveRecord = {
          type:
            "material",

          ...frontendMaterial(
            materialInsert.data
          ),
        };
      }
    }

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        "file.uploaded",

      metadata: {
        fileId:
          data.id,

        archiveRecordId:
          archiveRecord?.id ||
          null,
      },
    });

    res
      .status(201)
      .json({
        ...data,
        archiveRecord,
      });
  }
);

app.get(
  "/api/files/:id",
  requireAuth,
  async (req, res) => {
    const {
      data: file,
      error,
    } =
      await supabaseAdmin
        .from(
          "protected_files"
        )
        .select("*")
        .eq(
          "id",
          req.params.id
        )
        .single();

    if (
      error ||
      !file
    ) {
      return res
        .status(404)
        .json({
          error:
            "File not found",
        });
    }

    const canRead =
      file.owner_id ===
        req.profile.id ||
      [
        "hod",
        "admin",
        "super_admin",
      ].includes(
        req.profile.role
      );

    if (!canRead) {
      await writeSecurityLog({
        req,
        actor:
          req.profile,

        action:
          "file.access.denied",

        severity:
          "warning",

        metadata: {
          fileId:
            req.params.id,
        },
      });

      return res
        .status(403)
        .json({
          error:
            "File access denied",
        });
    }

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        "file.downloaded",

      metadata: {
        fileId:
          req.params.id,
      },
    });

    res.download(
      path.join(
        uploadRoot,
        file.storage_path
      ),
      file.original_name
    );
  }
);

app.get(
  "/api/files/:id/view",
  requireAuth,
  async (req, res) => {
    const {
      data: file,
      error,
    } =
      await supabaseAdmin
        .from(
          "protected_files"
        )
        .select("*")
        .eq(
          "id",
          req.params.id
        )
        .single();

    if (
      error ||
      !file
    ) {
      return res
        .status(404)
        .json({
          error:
            "File not found",
        });
    }

    const canRead =
      file.status ===
        "approved" ||
      file.owner_id ===
        req.profile.id ||
      [
        "hod",
        "admin",
        "super_admin",
      ].includes(
        req.profile.role
      );

    if (!canRead) {
      await writeSecurityLog({
        req,
        actor:
          req.profile,

        action:
          "file.view.denied",

        severity:
          "warning",

        metadata: {
          fileId:
            req.params.id,
        },
      });

      return res
        .status(403)
        .json({
          error:
            "File access denied",
        });
    }

    const diskPath =
      path.join(
        uploadRoot,
        file.storage_path
      );

    const isPdf =
      file.mime_type ===
        "application/pdf" ||
      path.extname(
        file.original_name ||
          ""
      ).toLowerCase() ===
        ".pdf";

    const pageCount =
      isPdf
        ? countPdfPages(
            diskPath
          )
        : 1;

    const pages =
      Array.from(
        {
          length:
            Math.min(
              pageCount,
              120
            ),
        },
        (_, index) => ({
          number:
            index + 1,

          label:
            `${
              isPdf
                ? "Page"
                : "Document"
            } ${index + 1}`,

          imageEndpoint:
            `/api/files/${file.id}/pages/${
              index + 1
            }`,
        })
      );

    await writeSecurityLog({
      req,
      actor:
        req.profile,

      action:
        "file.viewed",

      metadata: {
        fileId:
          req.params.id,

        pageCount,
      },
    });

    res.json({
      id:
        file.id,

      title:
        file.title,

      originalName:
        file.original_name,

      mimeType:
        file.mime_type,

      fileSize:
        file.file_size,

      pageCount,

      pages,

      renderedImages:
        true,

      policy: {
        downloadAllowed:
          false,

        copyAllowed:
          false,

        abstractOnlyDownload:
          true,
      },
    });
  }
);

app.get(
  "/api/files/:id/pages/:page",
  requireAuth,
  async (req, res) => {
    const {
      data: file,
      error,
    } =
      await supabaseAdmin
        .from(
          "protected_files"
        )
        .select("*")
        .eq(
          "id",
          req.params.id
        )
        .single();

    if (
      error ||
      !file
    ) {
      return res
        .status(404)
        .json({
          error:
            "File not found",
        });
    }

    const canRead =
      file.status ===
        "approved" ||
      file.owner_id ===
        req.profile.id ||
      [
        "hod",
        "admin",
        "super_admin",
      ].includes(
        req.profile.role
      );

    if (!canRead) {
      await writeSecurityLog({
        req,
        actor:
          req.profile,

        action:
          "file.page.denied",

        severity:
          "warning",

        metadata: {
          fileId:
            req.params.id,

          page:
            req.params.page,
        },
      });

      return res
        .status(403)
        .json({
          error:
            "File access denied",
        });
    }

    const isPdf =
      file.mime_type ===
        "application/pdf" ||
      path.extname(
        file.original_name ||
          ""
      ).toLowerCase() ===
        ".pdf";

    const pageNumber =
      Math.max(
        1,
        Number(
          req.params.page ||
            1
        )
      );

    const watermark =
      `${
        req.profile.full_name ||
        req.profile.email
      } · ${
        req.profile.matric_number ||
        req.profile.staff_id ||
        req.profile.role
      } · Nexaa`;

    try {
      const rendered =
        isPdf
          ? await renderPdfPageImage({
              file,
              pageNumber,
              watermark,
            })
          : await renderPlaceholderPageImage({
              file,
              pageNumber: 1,
              watermark,
            });

      await writeSecurityLog({
        req,
        actor:
          req.profile,

        action:
          "file.page.viewed",

        metadata: {
          fileId:
            req.params.id,

          page:
            rendered.pageNumber,
        },
      });

      res.setHeader(
        "content-type",
        "image/png"
      );

      res.setHeader(
        "cache-control",
        "private, no-store"
      );

      return res.sendFile(
        rendered.cachePath
      );
    } catch (
      renderError
    ) {
      await writeSecurityLog({
        req,
        actor:
          req.profile,

        action:
          "file.page.render_failed",

        severity:
          "warning",

        metadata: {
          fileId:
            req.params.id,

          page:
            pageNumber,

          message:
            renderError.message,
        },
      });

      return res
        .status(422)
        .json({
          error:
            "Could not render protected page image",
        });
    }
  }
);

app.use(
  (
    error,
    req,
    res,
    _next
  ) => {
    const status =
      error.message?.includes(
        "allowed"
      )
        ? 400
        : 500;

    writeSecurityLog({
      req,
      action:
        "api.error",

      severity:
        status >= 500
          ? "critical"
          : "warning",

      metadata: {
        message:
          error.message,
      },
    });

    res
      .status(status)
      .json({
        error:
          error.message ||
          "Unexpected API error",
      });
  }
);

app.listen(
  port,
  () => {
    console.log(
      `NEXA Security API listening on port ${port}`
    );

    if (
      missingEnv.length
    ) {
      console.warn(
        `Missing backend environment variables: ${missingEnv.join(
          ", "
        )}`
      );
    }
  }
);
