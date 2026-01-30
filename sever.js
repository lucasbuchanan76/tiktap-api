import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;

// CORS setup - allow all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Create temp directory for files
const TEMP_DIR = './temp';
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Store jobs in memory
const jobs = new Map();

// Voice IDs for ElevenLabs (current working voices)
const VOICE_IDS = {
  'female_1': 'EXAVITQu4vr4xnSDxMaL',  // Sarah
  'female_2': 'XB0fDUnXU5powFXDhCwa',  // Charlotte
  'male_1': 'TX3LPaxmHKxFdv7VOQHJ',    // Liam
};

// ============ ROUTES ============

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'TIKTAP.AI API is running' });
});

// Create video
app.post('/api/videos/create', async (req, res) => {
  const { script, template, voice, duration } = req.body;
  
  const jobId = uuidv4();
  const job = {
    id: jobId,
    status: 'pending',
    script,
    template,
    voice,
    duration,
    createdAt: new Date(),
    statusMessage: 'Starting video generation...',
  };
  
  jobs.set(jobId, job);
  
  // Start processing in background
  processVideo(jobId);
  
  res.json({ jobId, status: 'pending' });
});

// Get job status
app.get('/api/videos/:jobId/status', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// Get audio file
app.get('/api/videos/:jobId/audio', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.audioPath) {
    return res.status(404).json({ error: 'Audio not found' });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.sendFile(path.resolve(job.audioPath));
});

// Download final video
app.get('/api/videos/:jobId/download', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.finalVideoPath) {
    return res.status(404).json({ error: 'Video not found' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="tiktap-video-${job.id}.mp4"`);
  res.sendFile(path.resolve(job.finalVideoPath));
});

// ============ VIDEO PROCESSING ============

async function processVideo(jobId) {
  const job = jobs.get(jobId);
  
  try {
    // Step 1: Generate script with AI
    job.status = 'generating_script';
    job.statusMessage = 'Creating AI script...';
    jobs.set(jobId, job);
    
    const generatedScript = await generateScript(job.script, job.duration);
    job.generatedScript = generatedScript;
    jobs.set(jobId, job);
    
    // Step 2: Generate voiceover
    job.status = 'generating_voice';
    job.statusMessage = 'Creating AI voiceover...';
    jobs.set(jobId, job);
    
    const audioBuffer = await generateVoice(generatedScript, job.voice);
    const audioPath = `${TEMP_DIR}/${jobId}-audio.mp3`;
    fs.writeFileSync(audioPath, audioBuffer);
    job.audioPath = audioPath;
    job.hasAudio = true;
    jobs.set(jobId, job);
    
    // Get audio duration
    const audioDuration = await getAudioDuration(audioPath);
    
    // Step 3: Fetch stock footage
    job.status = 'fetching_footage';
    job.statusMessage = 'Finding perfect footage...';
    jobs.set(jobId, job);
    
    const videoPath = await fetchStockFootage(job.template, audioDuration, jobId);
    job.footagePath = videoPath;
    jobs.set(jobId, job);
    
    // Step 4: Combine audio + video with FFmpeg
    job.status = 'assembling_video';
    job.statusMessage = 'Assembling your video...';
    jobs.set(jobId, job);
    
    const finalVideoPath = await combineAudioVideo(audioPath, videoPath, jobId);
    job.finalVideoPath = finalVideoPath;
    
    // Complete!
    job.status = 'completed';
    job.statusMessage = 'Your video is ready!';
    job.videoUrl = `/api/videos/${jobId}/download`;
    jobs.set(jobId, job);
    
  } catch (error) {
    console.error('Video processing error:', error);
    job.status = 'failed';
    job.statusMessage = `Error: ${error.message}`;
    jobs.set(jobId, job);
  }
}

// ============ OPENAI - SCRIPT GENERATION ============

async function generateScript(topic, duration) {
  const wordCount = duration === '30' ? 75 : duration === '60' ? 150 : 225;
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a viral TikTok script writer. Write engaging, hook-driven scripts that capture attention in the first 2 seconds. Keep it around ${wordCount} words. No hashtags, no emojis, just the spoken script.`
        },
        {
          role: 'user',
          content: `Write a TikTok script about: ${topic}`
        }
      ],
      max_tokens: 500,
    }),
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error: ${err}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

// ============ ELEVENLABS - VOICE GENERATION ============

async function generateVoice(script, voiceType) {
  const voiceId = VOICE_IDS[voiceType] || VOICE_IDS['female_1'];
  
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: script,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs error: ${err}`);
  }
  
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============ PEXELS - STOCK FOOTAGE ============

async function fetchStockFootage(template, duration, jobId) {
  const searchTerms = {
    'motivational': 'motivation success',
    'educational': 'learning study',
    'lifestyle': 'lifestyle luxury',
    'fitness': 'workout gym',
    'business': 'business office',
    'travel': 'travel adventure',
    'default': 'aesthetic cinematic'
  };
  
  const query = searchTerms[template] || searchTerms['default'];
  
  const response = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=portrait`,
    {
      headers: {
        'Authorization': process.env.PEXELS_API_KEY,
      },
    }
  );
  
  if (!response.ok) {
    throw new Error('Failed to fetch stock footage');
  }
  
  const data = await response.json();
  
  if (!data.videos || data.videos.length === 0) {
    throw new Error('No stock footage found');
  }
  
  // Get random video from results
  const randomVideo = data.videos[Math.floor(Math.random() * data.videos.length)];
  
  // Get the HD video file
  const videoFile = randomVideo.video_files.find(f => f.quality === 'hd') || randomVideo.video_files[0];
  
  // Download the video
  const videoResponse = await fetch(videoFile.link);
  const videoBuffer = await videoResponse.arrayBuffer();
  const videoPath = `${TEMP_DIR}/${jobId}-footage.mp4`;
  fs.writeFileSync(videoPath, Buffer.from(videoBuffer));
  
  return videoPath;
}

// ============ FFMPEG - AUDIO & VIDEO PROCESSING ============

async function getAudioDuration(audioPath) {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    );
    return parseFloat(stdout.trim());
  } catch (error) {
    console.error('Error getting audio duration:', error);
    return 30; // Default to 30 seconds
  }
}

async function combineAudioVideo(audioPath, videoPath, jobId) {
  const outputPath = `${TEMP_DIR}/${jobId}-final.mp4`;
  
  // Get audio duration to trim/loop video accordingly
  const audioDuration = await getAudioDuration(audioPath);
  
  // FFmpeg command to:
  // 1. Take video input and loop if needed (-stream_loop -1)
  // 2. Take audio input
  // 3. Trim to audio length (-t)
  // 4. Encode video (H.264) and audio (AAC)
  // 5. Map video from first input, audio from second input
  // 6. Use -shortest to stop when shortest stream ends
  // 7. Add faststart for web streaming
  const ffmpegCommand = `ffmpeg -y \
    -stream_loop -1 -i "${videoPath}" \
    -i "${audioPath}" \
    -t ${audioDuration} \
    -c:v libx264 -preset fast -crf 23 \
    -c:a aac -b:a 128k \
    -map 0:v:0 -map 1:a:0 \
    -shortest \
    -movflags +faststart \
    "${outputPath}"`;
  
  try {
    await execPromise(ffmpegCommand);
    return outputPath;
  } catch (error) {
    console.error('FFmpeg error:', error);
    throw new Error('Failed to combine audio and video');
  }
}

// ============ CLEANUP OLD FILES ============

// Clean up temp files older than 1 hour (runs every 30 minutes)
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  if (fs.existsSync(TEMP_DIR)) {
    fs.readdirSync(TEMP_DIR).forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs < oneHourAgo) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up: ${file}`);
        }
      } catch (err) {
        console.error(`Error cleaning up ${file}:`, err);
      }
    });
  }
}, 30 * 60 * 1000);

// ============ START SERVER ============

app.listen(PORT, () => {
  console.log(`🚀 TIKTAP API running on port ${PORT}`);
  console.log(`📁 Temp directory: ${TEMP_DIR}`);
});
