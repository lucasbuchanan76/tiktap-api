// Fixed code (with audio overlay):
const result = await cloudinary.uploader.upload(videoPath, {
  resource_type: "video",
  folder: "tiktap-videos",
  // Add audio transformation
  transformation: [
    {
      overlay: {
        resource_type: "audio",
        public_id: audioPublicId  // This is your uploaded audio file ID
      },
      flags: "layer_apply"
    }
  ]
});
