import { image } from "./llm.js";
for (let i=1;i<=2;i++){
  const s=Date.now();
  try { const u=await image("north-star logo, navy violet, minimalist vector, white bg"); console.log(`#${i} OK ${((Date.now()-s)/1000).toFixed(1)}s ~${Math.round(u.length*0.75/1024)}KB ${u.slice(0,16)}`); }
  catch(e){ console.log(`#${i} ERR ${((Date.now()-s)/1000).toFixed(1)}s ${e.message.slice(0,80)}`); }
}
process.exit(0);
