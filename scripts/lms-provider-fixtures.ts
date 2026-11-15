/** Controlled SDK fixtures for controller conformance; never shipped in frontend or treated as live provider evidence. */
export const youtubeSdkFixture = `
window.YT={Player:class {
 constructor(frame,options){this.frame=frame;this.options=options;this.seconds=0;this.state=2;this.at=performance.now();this.listener=event=>{if(event.source===frame.contentWindow&&event.origin==='https://www.youtube-nocookie.com'&&event.data==='fixture-play')this.playVideo();};window.addEventListener('message',this.listener);setTimeout(()=>options.events.onReady({target:this}),40);window.aioProviderFixture={emitInvalid(){options.events.onStateChange(null);options.events.onStateChange({data:'0'});}};}
 getIframe(){return this.frame;}
 getCurrentTime(){if(this.state===1){const now=performance.now();this.seconds+=(now-this.at)/1000;this.at=now;if(this.seconds>=3){this.seconds=3;this.state=0;setTimeout(()=>this.options.events.onStateChange({data:0}),0);}}return this.seconds;}
 getPlayerState(){return this.state;}
 playVideo(){this.at=performance.now();this.state=1;this.options.events.onStateChange({data:1});}
 pauseVideo(){this.getCurrentTime();this.state=2;}
 seekTo(seconds){this.seconds=seconds;this.at=performance.now();}
 destroy(){window.removeEventListener('message',this.listener);this.frame.remove();}
}};window.onYouTubeIframeAPIReady?.();`;
// This media continues past the configured course duration, so there is no ended event at the limit.
export const vimeoSdkFixture = `
window.Vimeo={Player:class {
 constructor(frame){this.frame=frame;this.events={};this.seconds=0;this.playing=false;this.listener=event=>{if(event.source===frame.contentWindow&&event.origin==='https://player.vimeo.com'&&event.data==='fixture-play')this.play();};window.addEventListener('message',this.listener);this.timer=setInterval(()=>{if(!this.playing)return;this.seconds=Math.min(9,(Math.round(this.seconds*10)+1)/10);this.events.timeupdate?.({seconds:this.seconds});if(this.seconds>=9){this.playing=false;this.events.ended?.({seconds:9});}},100);window.aioProviderFixture={emitInvalid:()=>{this.events.timeupdate?.(null);this.events.timeupdate?.({seconds:-1});this.events.ended?.({seconds:'9'});}};}
 ready(){return Promise.resolve();} on(name,callback){this.events[name]=callback;}
 play(){this.playing=true;this.events.play?.({});return Promise.resolve();}
 pause(){this.playing=false;return Promise.resolve();}
 setCurrentTime(seconds){this.seconds=seconds;return Promise.resolve(seconds);}
 destroy(){clearInterval(this.timer);window.removeEventListener('message',this.listener);this.frame.remove();return Promise.resolve();}
}};`;
export const providerFrameFixture =
  '<!doctype html><html lang="vi"><meta charset="UTF-8"><title>Provider fixture</title><body><button style="min-height:44px" onclick="parent.postMessage(\'fixture-play\',\'http://127.0.0.1:4104\')">Phát video kiểm thử</button><p>Controlled provider test only</p></body></html>';
