/* Decorative snow pauses in background tabs and honors reduced motion. */
const canvas=document.getElementById('snow'),toggle=document.getElementById('snowToggle');
if(canvas){
  const context=canvas.getContext('2d'),motion=matchMedia('(prefers-reduced-motion: reduce)');
  let enabled=true,width=0,height=0,flakes=[],frame=0,last=0;
  try{enabled=localStorage.getItem('banditblox.snow')!=='off';}catch{}
  function flake(randomY){return {x:Math.random()*width,y:randomY?Math.random()*height:-6,r:.45+Math.random()*1.35,s:9+Math.random()*17,phase:Math.random()*Math.PI*2,alpha:.15+Math.random()*.36};}
  function size(){
    width=innerWidth;height=innerHeight;const dpr=Math.min(1.5,devicePixelRatio||1);
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);context?.setTransform(dpr,0,0,dpr,0,0);
    flakes=Array.from({length:Math.max(12,Math.min(75,Math.round(width*height/22000)))},()=>flake(true));
  }
  function draw(now){
    frame=requestAnimationFrame(draw);if(now-last<32)return;
    const dt=Math.min(80,now-last)/1000;last=now;context.clearRect(0,0,width,height);context.fillStyle='#eef5ff';
    for(const f of flakes){f.y+=f.s*dt;f.phase+=dt*.6;f.x+=Math.sin(f.phase)*dt*5;if(f.y>height+6)Object.assign(f,flake(false));
      context.globalAlpha=f.alpha;context.beginPath();context.arc(f.x,f.y,f.r,0,Math.PI*2);context.fill();}
  }
  function update(){
    const active=!!context&&enabled&&!motion.matches&&!document.hidden;
    if(toggle){toggle.textContent=motion.matches?'Snow · reduced motion':enabled?'Snow on':'Snow off';toggle.setAttribute('aria-pressed',String(enabled&&!motion.matches));toggle.disabled=motion.matches||!context;}
    canvas.hidden=!active;
    if(active&&!frame){last=performance.now();frame=requestAnimationFrame(draw);}
    else if(!active&&frame){cancelAnimationFrame(frame);frame=0;context?.clearRect(0,0,width,height);}
  }
  toggle?.addEventListener('click',()=>{enabled=!enabled;try{localStorage.setItem('banditblox.snow',enabled?'on':'off');}catch{}update();});
  document.addEventListener('visibilitychange',update);motion.addEventListener('change',update);window.addEventListener('resize',size,{passive:true});
  window.addEventListener('storage',e=>{if(e.key==='banditblox.snow'){enabled=e.newValue!=='off';update();}});
  size();update();
}
