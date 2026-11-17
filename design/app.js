// Progressive enhancement only: live countdowns, periodic refresh of live pages, confirmations.
(function(){
  function fmt(ms){var neg=ms<0,s=Math.round(Math.abs(ms)/1000);return (neg?'+':'')+Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
  var timers=document.querySelectorAll('[data-remaining-ms]');var start=Date.now();
  function tick(){timers.forEach(function(el){var base=Number(el.getAttribute('data-remaining-ms'));var run=el.getAttribute('data-running')==='1';var ms=run?base-(Date.now()-start):base;el.textContent=fmt(ms);el.classList.toggle('over',ms<0)})}
  if(timers.length){tick();setInterval(tick,250)}
  var r=document.querySelector('[data-refresh]');if(r){setTimeout(function(){location.reload()},Number(r.getAttribute('data-refresh'))*1000)}
  document.addEventListener('submit',function(e){var b=e.target.querySelector('[data-confirm]');if(b&&!window.confirm(b.getAttribute('data-confirm')))e.preventDefault()});
})();
