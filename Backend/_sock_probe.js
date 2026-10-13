const { io } = require('socket.io-client');
function probe(origin, label){
  return new Promise((resolve)=>{
    const s = io('http://127.0.0.1:5000', {
      transports: ['polling','websocket'],
      extraHeaders: { Origin: origin, Referer: origin + '/' },
      reconnection: false,
      timeout: 6000,
    });
    const done = (msg)=>{ try{s.close();}catch(e){} resolve(label+': '+msg); };
    setTimeout(()=>done('TIMEOUT'), 6500);
    s.on('connect', ()=> done('CONNECTED id='+s.id));
    s.on('connect_error', (e)=> done('CONNECT_ERROR '+ (e && e.message)));
  });
}
(async()=>{
  console.log(await probe('http://localhost:5500','origin localhost:5500'));
  console.log(await probe('http://192.168.1.10:5500','origin LAN 192.168'));
  console.log(await probe('http://127.0.0.1:5500','origin 127.0.0.1:5500'));
})();
