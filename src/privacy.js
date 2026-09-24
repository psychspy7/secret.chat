// Browsers cannot prevent OS screenshots. This shield reduces accidental exposure.
export function installPrivacyShield() {
  const shield=document.createElement('section');
  shield.className='privacy-shield';
  shield.hidden=true;
  shield.setAttribute('role','dialog');
  shield.setAttribute('aria-modal','true');
  shield.setAttribute('aria-labelledby','shield-title');
  shield.innerHTML='<div class="card"><div class="lock">▣</div><h2 id="shield-title">Chat hidden</h2><p>Your conversation is covered while you are away.</p><button class="button" id="reveal-chat">Reveal chat</button><p class="limit-note">Screenshots and external cameras cannot be blocked by a website.</p></div>';
  document.body.append(shield);
  const hide=()=>{
    if(!document.querySelector('.chat'))return;
    document.querySelector('#app').inert=true;
    document.documentElement.classList.add('chat-covered');
    shield.hidden=false;
    shield.querySelector('button').focus();
  };
  const reset=()=>{
    shield.hidden=true;
    document.documentElement.classList.remove('chat-covered');
    document.querySelector('#app').inert=false;
  };
  shield.querySelector('button').onclick=()=>{reset();document.querySelector('[name=message]')?.focus()};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)hide()});
  window.addEventListener('pagehide',hide);
  window.addEventListener('beforeprint',hide);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&document.querySelector('.chat')){event.preventDefault();hide()}
  });
  return {hide,reset};
}
