import { serve } from "@hono/node-server";
import { Hono } from "hono";
import ffmpeg from "ffmpeg-static";
import { spawn } from "child_process";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink, readFile } from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
// @ts-ignore
import fetch from "node-fetch";

dotenv.config();

// Types
interface VideoRequest {
  images: string[];
  duration: number;
}

interface S3Config {
  region: string;
  endpoint: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

// Constants
const PORT = 3000;
const BASE_S3_URL = `https://r2.shubh.one`;
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || "";
const ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const BUCKET = process.env.AWS_S3_BUCKET || "";
const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "";
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "";
const REGION = process.env.AWS_REGION || "";

// S3 Configuration
const s3Config: S3Config = {
  region: REGION,
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
};

// Initialize clients
const s3Client = new S3Client(s3Config);
const app = new Hono();

// Helper Functions
async function downloadImage(url: string, index: number): Promise<string> {
  console.log(`Downloading image ${index + 1} from: ${url}`);
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const tempPath = join(tmpdir(), `image_${index}.jpg`);
  await writeFile(tempPath, Buffer.from(buffer));
  console.log(`Successfully downloaded image ${index + 1} to ${tempPath}`);
  return tempPath;
}

async function downloadAllImages(images: string[]): Promise<string[]> {
  return Promise.all(images.map((url, index) => downloadImage(url, index)));
}

function buildFFmpegArgs(imageFiles: string[], duration: number): string[] {
  return [
    "-y",
    ...imageFiles.flatMap((file) => [
      "-loop",
      "1",
      "-t",
      duration.toString(),
      "-i",
      file,
    ]),
    "-filter_complex",
    buildFilterComplex(imageFiles.length, duration),
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
  ];
}

function buildFilterComplex(imageCount: number, duration: number): string {
  const scaleCommands = Array(imageCount)
    .fill(0)
    .map(
      (_, i) =>
        `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fade=t=in:st=0:d=1:alpha=1,fade=t=out:st=${
          duration - 1
        }:d=1:alpha=1[v${i}];`,
    )
    .join("");

  const inputStreams = Array(imageCount)
    .fill(0)
    .map((_, i) => `[v${i}]`)
    .join("");

  return `${scaleCommands}${inputStreams}concat=n=${imageCount}:v=1:a=0,format=yuv420p[v]`;
}

async function executeFFmpeg(
  outputPath: string,
  ffmpegArgs: string[],
): Promise<void> {
  console.log("FFmpeg command:", ffmpeg, ffmpegArgs.join(" "));

  return new Promise((resolve, reject) => {
    const process = spawn(ffmpeg as unknown as string, [
      ...ffmpegArgs,
      outputPath,
    ]);

    process.stderr.on("data", (data) => {
      console.log(`FFmpeg output: ${data}`);
    });

    process.on("close", (code) => {
      console.log(`FFmpeg process completed with code ${code}`);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg process exited with code ${code}`));
    });
  });
}

async function uploadToS3(fileContent: Buffer): Promise<string> {
  const key = `videos/${uuidv4()}.mp4`;
  console.log(`Uploading to S3 with key: ${key}`);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileContent,
      ContentType: "video/mp4",
    }),
  );

  return key;
}

async function cleanupFiles(files: string[]): Promise<void> {
  await Promise.all(files.map((file) => unlink(file)));
}

async function createVideo(
  images: string[],
  duration: number,
): Promise<string> {
  const imageFiles = await downloadAllImages(images);
  const outputPath = join(tmpdir(), `${uuidv4()}.mp4`);

  try {
    const ffmpegArgs = buildFFmpegArgs(imageFiles, duration);
    await executeFFmpeg(outputPath, ffmpegArgs);

    const fileContent = await readFile(outputPath);
    const key = await uploadToS3(fileContent);

    await cleanupFiles([...imageFiles, outputPath]);

    return `${BASE_S3_URL}/${key}`;
  } catch (error) {
    await cleanupFiles([...imageFiles, outputPath]);
    throw error;
  }
}

app.get("/", (c) => c.text("Hello World"));

// Route Handler
app.post("/create-video", async (c) => {
  try {
    console.log("Received request to create video");
    const { images, duration } = await c.req.json<VideoRequest>();
    console.log(
      `Processing ${images.length} images with ${duration}s duration each`,
    );

    const videoUrl = await createVideo(images, duration);
    console.log(`Video creation completed. URL: ${videoUrl}`);

    return c.json({ url: videoUrl });
  } catch (error) {
    console.error("Error creating video:", error);
    if (error instanceof Error) {
      console.error("Error details:", error.message, error.stack);
    }
    return c.json({ error: "Failed to create video" }, 500);
  }
});

// Start server
console.log(`Server is running on http://localhost:${PORT}`);
serve({
  fetch: app.fetch,
  port: PORT,
});
