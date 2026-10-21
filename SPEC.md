# Video to GIF Converter — specification

**Tagline:** Turn a video clip into a looping GIF in your browser, with size and speed controls and no upload.

**Category:** Audio & Video

**Free alternative to:** EZGIF Video to GIF (uploads your video to a server, 100 MB upload limit, ads on every page)

**Search phrases:** video to gif, mp4 to gif, convert video to gif, gif maker from video, mov to gif, make gif from video free, video to gif no watermark

**Allowed libraries:** gif.js

**Published at:** https://turhe123.github.io/video-to-gif-local/

## Acceptance checks (each must have a test)

- Loading sample-clip.mp4 shows a video preview with start and end sliders
- Pressing Make GIF produces a downloadable .gif larger than 1 KB
- Changing width to 320 and frame rate to 10 makes the estimated size smaller
- The result shows frame count, dimensions and file size
- A file that is not a video shows an error message
- Works at 390px wide

## Spec

Video to gif is one of the most searched conversion jobs. The best known site works but uploads your clip to its server, caps uploads at a fixed size, and wraps every step in ads. Other tools add watermarks or ask for an account to remove limits. Our version converts a chosen part of a local video into a GIF entirely in the page.

Feature set: load one video the browser can play (MP4, WebM, MOV where supported). Choose start time and end time, with a hard cap of 20 seconds by default and a warning above that. Choose output width (default 480, choices 240, 320, 480, 640, original up to 800), frame rate (default 10, choices 5, 8, 10, 12, 15), quality (default medium) and loop (forever by default, or once). Show an estimated file size before and the real size after. Output is one GIF only. No text overlays, no effects.

UI: a drop zone at the top, then a video element with play controls and a range selector for start and end, plus numeric inputs. Options sit in a compact row below. A Make GIF button shows a progress bar with frames done out of total. The result area shows the animated GIF preview, frame count, dimensions, size and a Download GIF button named after the video with a gif suffix. Empty state explains that processing is local. Errors for unsupported codecs say to try an MP4 with H.264. Keyboard: space plays and pauses the preview, Enter starts the conversion.

Technical approach: create a video element from an object URL, muted and playsinline. For each frame time between start and end at the chosen rate, set currentTime, wait for the seeked event, draw the video onto a canvas at the target size and hand the canvas to the gif.js encoder with its delay set from the frame rate. gif.js runs its encoding in Web Workers, using the vendored worker script, so the page stays responsive. Use the quality setting to set its sampling parameter. Collect the rendered Blob, show it in an image element and offer the download. Seeking is slower than playback but gives exact frames and works consistently in all engines.

Edge cases: large 4K videos should be downscaled while drawing, never at original size. Memory grows with frames times width times height, so compute the estimate and refuse more than around 300 frames at 800 pixels with a clear message. Mobile Safari may require a user tap before the video loads data, so call load on the tap and wait for loadeddata. Videos with rotation metadata are handled by the browser. Dropped files with no video track show an error. GIF has no audio, so say so. Remind the user that GIFs are large and that WebM is smaller.

Demo data: a bundled five second generated clip of a bouncing coloured ball on a grey background, named sample-clip, so the conversion output visibly loops.
