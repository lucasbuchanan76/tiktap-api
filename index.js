const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

// CORS - Allow all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// In-memory job storage
const jobs = new Map();

// Voice ID mapping
const VOICE_IDS = {
  'female_1': '21m00Tcm4TlvDq8ikWAM',
  'female_2': 'ThT5KcBeYPX3keUQqHPh',
  'male_1': 'pNInz6obpgDQGcFmaJgB',
};

// ============ ROUTES ============

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'TIKTAP.AI API is running' });
});

// Create video job
app.post('/api/videos/create', async (req, res) => {
  try {
    const { script, template, voice, duration } = req.body;
    
    const jobId = uuidv4();
    const job = {
      id: jobId,
      status: 'queued',
      statusMessage: 'Video job created...',
      inputScript: script,
      template,
      voice,
      duration,
      generatedScript: null,
      hasAudio: false,
      videoUrl: null,
      createdAt: new Date(),
    };
    
    jobs.set(jobId, job);
    
    // Start processing in background
    processVideo(jobId);
    
    res.json({ jobId, status: 'queued' });
  } catch (error) {
    console.error('Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get job status
app.get('/api/videos/:jobId/status', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  // Don't send audio buffer in status
  const { audioBuffer, ...jobData } = job;
  res.json(jobData);
});

// Get audio file
app.get('/api/videos/:jobId/audio', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.audioBuffer) {
    return res.status(404).json({ error: 'Audio not found' });
  }
  res.set('Content-Type', 'audio/mpeg');
  res.send(job.audioBuffer);
});

// Download video
app.get('/api/videos/:jobId/download', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.videoUrl) {
    return res.status(404).json({ error: 'Video not ready' });
  }
  res.redirect(job.videoUrl);
});

// ============ VIDEO PROCESSING ============

async function processVideo(jobId) {
  const job = jobs.get(jobId);
  
  try {
    // Step 1: Generate Script
    job.status = 'generating_script';
    job.statusMessage = 'AI is writing your script...';
    jobs.set(jobId, job);
    
    const script = await generateScript(job.inputScript, job.duration);
    job.generatedScript = script;
    jobs.set(jobId, job);
    
    // Step 2: Generate Voice
    job.status = 'generating_voice';
    job.statusMessage = 'Creating AI voiceover...';
    jobs.set(jobId, job);
    
    const audioBuffer = await generateVoice(script, job.voice);
    job.audioBuffer = audioBuffer;
    job.hasAudio = true;
    jobs.set(jobId, job);
    
    // Step 3: Fetch Stock Footage
    job.status = 'fetching_footage';
    job.statusMessage = 'Finding perfect video clips...';
    jobs.set(jobId, job);
    
    const clips = await fetchStockFootage(script);
    job.clips = clips;
    jobs.set(jobId, job);
    
    // Step 4: Assemble Video
    job.status = 'assembling_video';
    job.statusMessage = 'Assembling your video...';
    jobs.set(jobId, job);
    
    const videoUrl = await assembleVideo(job);
    job.videoUrl = videoUrl;
    job.status = 'completed';
    job.statusMessage = 'Your video is ready!';
    jobs.set(jobId, job);
    
  } catch (error) {
    console.error('Process error:', error);
    job.status = 'failed';
    job.statusMessage = `Error: ${error.message}`;
    jobs.set(jobId, job);
  }
}

// ============ OPENAI ============

async function generateScript(topic, duration) {
  const wordCount = duration === '30s' ? 75 : duration === '60s' ? 150 : 225;
  
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
          content: `You are a viral short-form video scriptwriter. Write engaging scripts for TikTok/Reels/Shorts. Start with a hook. Keep it around ${wordCount} words. No emojis. Just spoken words.`
        },
        {
          role: 'user',
          content: `Write a script about: ${topic}`
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

// ============ ELEVENLABS ============

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
      model_id: 'eleven_monolingual_v1',
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

// ============ PEXELS ============

async function fetchStockFootage(script) {
  const keywords = script.split(' ')
    .filter(word => word.length > 5)
    .slice(0, 3)
    .join(' ') || 'business technology';
  
  const response = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(keywords)}&per_page=5&orientation=portrait`,
    {
      headers: {
        'Authorization': process.env.PEXELS_API_KEY,
      },
    }
  );
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Pexels error: ${err}`);
  }
  
  const data = await response.json();
  
  return data.videos.map(video => ({
    id: video.id,
    url: video.video_files.find(f => f.quality === 'hd')?.link || video.video_files[0]?.link,
    duration: video.duration,
  }));
}

// ============ SHOTSTACK ============

async function assembleVideo(job) {
  const clips = job.clips || [];
  
  if (clips.length === 0) {
    throw new Error('No video clips found');
  }
  
  const videoClips = clips.slice(0, 3).map((clip, index) => ({
    asset: {
      type: 'video',
      src: clip.url,
      trim: 0,
    },
    start: index * 10,
    length: 10,
    fit: 'cover',
  }));
  
  const renderPayload = {
    timeline: {
      tracks: [{ clips: videoClips }],
    },
    output: {
      format: 'mp4',
      size: {
        width: 1080,
        height: 1920,
      },
    },
  };
  
  const renderResponse = await fetch('https://api.shotstack.io/stage/render', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.SHOTSTACK_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(renderPayload),
  });
  
  if (!renderResponse.ok) {
    const err = await renderResponse.text();
    throw new Error(`Shotstack render error: ${err}`);
  }
  
  const renderData = await renderResponse.json();
  const renderId = renderData.response.id;
  
  // Poll for completion (max 2 minutes)
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const statusResponse = await fetch(`https://api.shotstack.io/stage/render/${renderId}`, {
      headers: {
        'x-api-key': process.env.SHOTSTACK_API_KEY,
      },
    });
    
    const statusData = await statusResponse.json();
    
    if (statusData.response.status === 'done') {
      return statusData.response.url;
    } else if (statusData.response.status === 'failed') {
      throw new Error('Video rendering failed');
    }
  }
  
  throw new Error('Video rendering timed out');
}

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TIKTAP.AI API running on port ${PORT}`);
});
