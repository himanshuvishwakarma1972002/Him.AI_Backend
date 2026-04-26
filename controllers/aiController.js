import "dotenv/config";
import sql from "../configs/db.js";
import { v2 as cloudinary } from "cloudinary";
import axios from "axios";
import fs from "fs";
import FormData from "form-data";
import { PDFParse } from "pdf-parse";
import { clerkClient } from "@clerk/express";
import OpenAI from "openai";



const AI = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai"
});
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-3-flash-preview").replace(/"/g, "").trim();
const FALLBACK_MODELS = [...new Set([
  GEMINI_MODEL,
  "gemini-3-flash-preview"

])];

const createChatCompletion = async (messages, maxTokens) => {
  let lastError;
  for (const model of FALLBACK_MODELS) {
    try {
      return await AI.chat.completions.create({
        model,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

const buildResumeFallbackReview = (resumeText) => {
  const text = (resumeText || "").toLowerCase();
  const sections = {
    summary: /summary|profile|objective/.test(text),
    skills: /skills|tech stack|technologies/.test(text),
    experience: /experience|employment|work history/.test(text),
    projects: /project/.test(text),
    education: /education|university|college|school/.test(text),
  };

  const missing = Object.entries(sections)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  return [
    "AI review service is temporarily unavailable, so this is a fallback resume review.",
    "",
    "Strengths:",
    "- Resume file was parsed successfully.",
    `- Detected sections: ${Object.entries(sections).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}.`,
    "",
    "Improvements:",
    `- Add missing sections: ${missing.length ? missing.join(", ") : "none"}.`,
    "- Add measurable impact in experience/project bullets (numbers, percentages, outcomes).",
    "- Keep each bullet action-oriented and concise.",
    "- Tailor skills and keywords to the target job description."
  ].join("\n");
};

// ================== ARTICLE ==================
export const generateArticle = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { prompt, length } = req.body;
    const plan = req.plan;
    const free_usage = req.free_usage;

    if (plan === 'premium' && free_usage >= 10) {
      return res.json({ success: false, message: "You have reached your free usage limit. Upgrade to a premium plan to continue using the AI generator." });
      
    }
    const response = await createChatCompletion([{
              role: "user",
              content: prompt,
          },
      ], length);

  const content = response.choices[0].message.content;

    await sql`
      INSERT INTO creations (user_id, prompt, content, type)
      VALUES (${userId}, ${prompt}, ${content}, 'article')`;

      if(plan === 'premium'){
        await clerkClient.users.updateUserMetadata(userId, {
          privateMetadata: {
            free_usage: free_usage + 1
          }
        })
      }

    res.json({ success: true, content });

  } catch (error) {
    console.log(error.message)
    res.json({success: false, message: error.message})
}
}
  

// ================== BLOG TITLE ==================
export const generateBlogTitle = async (req, res) => {
  try {
    // ✅ FIX: auth()
    const { userId } = req.auth();
    const { prompt } = req.body;
    const plan = req.plan;
    const free_usage = req.free_usage;

    // ✅ validation
    if (!prompt || prompt.trim() === "") {
      return res.json({
        success: false,
        message: "Prompt is required",
      });
    }

    // ✅ FIX: correct usage logic
    if (plan === 'free' && free_usage >= 10) {
      return res.json({
        success: false,
        message: "Free limit reached. Upgrade to premium."
      });
    }

    // ✅ BETTER PROMPT (VERY IMPORTANT)
    const aiPrompt = `Generate exactly 5 catchy, SEO-friendly blog titles for the topic: "${prompt}".

Rules:
- Each title on a new line
- No numbering
- No explanation
- Keep them short and engaging`;

    // ✅ USE YOUR FALLBACK FUNCTION
    const response = await createChatCompletion(
      [{ role: "user", content: aiPrompt }],
      500
    );

    let content = response?.choices?.[0]?.message?.content || "";

    // ✅ CLEAN OUTPUT
    const titles = content
      .split("\n")
      .map(t => t.replace(/^\d+[\).\-\s]*/, "").trim())
      .filter(t => t.length > 0);

    const finalContent = titles.join("\n");

    // ✅ SAVE TO DATABASE
    await sql`
      INSERT INTO creations (user_id, prompt, content, type)
      VALUES (${userId}, ${prompt}, ${finalContent}, 'blog-title')
    `;

    // ✅ UPDATE USAGE
    if (plan === 'free') {
      await clerkClient.users.updateUserMetadata(userId, {
        privateMetadata: {
          free_usage: free_usage + 1
        }
      });
    }

    // ✅ RESPONSE (better for frontend)
    res.json({
      success: true,
      titles,       // array (BEST)
      content: finalContent // fallback (string)
    });

  } catch (error) {
    console.log("BLOG TITLE ERROR:", error.message);

    res.json({
      success: false,
      message: error.message || "Failed to generate blog titles",
    });
  }
};
// ================== IMAGE ==================

export const generateImage = async (req, res) => {
  try {
    // ✅ AUTH (important)
    const { userId } = req.auth();

    const { prompt, publish } = req.body;

    // ✅ VALIDATION
    if (!prompt || prompt.trim() === "") {
      return res.json({
        success: false,
        message: "Prompt is required",
      });
    }

    // ✅ CREATE FORM DATA
    const formData = new FormData();
    formData.append("prompt", prompt);

    // ✅ CALL CLIPDROP API
    const response = await axios.post(
      "https://clipdrop-api.co/text-to-image/v1",
      formData,
      {
        headers: {
          "x-api-key": process.env.CLIPDROP_API_KEY,
          ...formData.getHeaders(), // 🔥 IMPORTANT
        },
        responseType: "arraybuffer",
      }
    );

    // ✅ CONVERT TO BASE64
    const base64 = Buffer.from(response.data).toString("base64");

    // ✅ UPLOAD TO CLOUDINARY
    const upload = await cloudinary.uploader.upload(
      `data:image/png;base64,${base64}`,
      {
        folder: "ai_images",
      }
    );

    const imageUrl = upload.secure_url;

    // ✅ SAVE TO DATABASE
    await sql`
      INSERT INTO creations (user_id, prompt, content, type, publish)
      VALUES (${userId}, ${prompt}, ${imageUrl}, 'image', ${publish ?? false})
    `;

    // ✅ RESPONSE
    res.json({
      success: true,
      content: imageUrl,
    });

  } catch (error) {
    console.log("IMAGE ERROR:", error.response?.data || error.message);

    res.json({
      success: false,
      message: error.response?.data?.error || "Image generation failed",
    });
  }
};

// ================== REMOVE BG ==================


export const removeImageBackground = async (req, res) => {
  try {
    // ✅ AUTH
    const { userId } = req.auth();

    const plan = req.plan;

    // ✅ CHECK FILE
    if (!req.file) {
      return res.json({
        success: false,
        message: "No image uploaded",
      });
    }

    // ✅ PREMIUM CHECK
    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is only available for premium users.",
      });
    }

    // ✅ UPLOAD + REMOVE BG
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: "ai_bg_removed",
      transformation: [{ effect: "background_removal" }],
    });

    const imageUrl = result.secure_url;

    // ✅ DELETE TEMP FILE
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // ✅ SAVE TO DATABASE
    await sql`
      INSERT INTO creations (user_id, prompt, content, type, publish)
      VALUES (${userId}, 'Background removed image', ${imageUrl}, 'image', false)
    `;

    // ✅ RESPONSE
    res.json({
      success: true,
      content: imageUrl,
    });

  } catch (error) {
    console.log("REMOVE BG ERROR:", error.message);

    res.json({
      success: false,
      message: error.message || "Background removal failed",
    });
  }
};

// ================== REMOVE OBJECT ==================


export const removeImageObject = async (req, res) => {
  try {
    // ✅ AUTH
    const { userId } = req.auth();

    const { object } = req.body;
    const image = req.file;
    const plan = req.plan;

    // ✅ VALIDATION
    if (!image) {
      return res.json({ success: false, message: "No image uploaded" });
    }

    if (!object || object.trim() === "") {
      return res.json({ success: false, message: "Object is required" });
    }

    // ✅ PREMIUM CHECK
    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is only available for premium users.",
      });
    }

    // ✅ UPLOAD IMAGE FIRST
    const upload = await cloudinary.uploader.upload(image.path);

    // ✅ CLEAN OBJECT NAME
    const normalizedObject = object
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");

    // ✅ REMOVE OBJECT
    const imageUrl = cloudinary.url(upload.public_id, {
      resource_type: "image",
      secure: true,
      transformation: [{ effect: `gen_remove:prompt_${normalizedObject}` }],
    });

    // ✅ DELETE TEMP FILE
    if (fs.existsSync(image.path)) {
      fs.unlinkSync(image.path);
    }

    // ✅ SAVE TO DB
    await sql`
      INSERT INTO creations (user_id, prompt, content, type, publish)
      VALUES (${userId}, ${`Removed ${object} from image`}, ${imageUrl}, 'image', false)
    `;

    res.json({ success: true, content: imageUrl });

  } catch (error) {
    console.log("REMOVE OBJECT ERROR:", error.message);

    res.json({
      success: false,
      message: error.message || "Object removal failed",
    });
  }
};

// ================== RESUME REVIEW ==================
export const resumeReview = async (req, res) => {
  try {
    const { userId } = req.auth();

    if (!req.file) {
      return res.json({
        success: false,
        message: "Please upload a resume PDF"
      });
    }

    // ✅ Read PDF
    const buffer = fs.readFileSync(req.file.path);
    const parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    await parser.destroy();

    let content = "";

    try {
      const prompt = `
Analyze the following resume and provide a professional review.

Return the response STRICTLY in markdown format.

Structure:

# Resume Analysis

## Strengths
- Bullet points

## Weaknesses
- Bullet points

## Improvements
- Actionable suggestions

## ATS Score
**Score:** XX/100  
Short explanation

Keep formatting clean, readable and professional.

Resume:
${data.text}
      `;

      const response = await createChatCompletion(
        [{ role: "user", content: prompt }],
        1500
      );

      content = response.choices[0].message.content;

    } catch (aiError) {
      console.log("RESUME AI ERROR:", aiError?.status, aiError?.message);

      content = `
# Resume Analysis

## Strengths
- Unable to analyze properly

## Weaknesses
- AI service unavailable

## Improvements
- Try again later

## ATS Score
**Score:** 50/100
`;
    }

    // ✅ Save to DB
    await sql`
      INSERT INTO creations (user_id, prompt, content, type)
      VALUES (${userId}, ${"Resume Review"}, ${content}, 'resume-review')
    `;

    // ✅ Delete temp file
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.json({
      success: true,
      content
    });

  } catch (error) {
    console.log("RESUME ERROR:", error.message);

    res.json({
      success: false,
      message: error.message || "Resume review failed"
    });
  }
};