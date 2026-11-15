import type { Page } from '@playwright/test';
/** Silent, generated test footage. No user media or external download. */
export async function recordedLmsVideo(page: Page, durationMs = 1800) {
  const bytes = await page.evaluate(async (durationMs) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const stream = canvas.captureStream(10),
      recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }),
      chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error('Fixture recorder failed'));
    });
    let frame = 0;
    context.fillStyle = '#223873';
    context.fillRect(0, 0, 320, 180);
    recorder.start(100);
    const timer = setInterval(() => {
      context.fillStyle = '#223873';
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#087C3C';
      context.fillRect(35, 125, Math.min(250, (++frame * 250) / (durationMs / 100)), 8);
      context.fillStyle = '#FFFFFF';
      context.font = '20px Arial';
      context.fillText('TLQM LMS · Local', 35, 90);
    }, 100);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    clearInterval(timer);
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
  }, durationMs);
  return Buffer.from(bytes);
}
