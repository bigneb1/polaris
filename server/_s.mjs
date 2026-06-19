import { ethers } from "ethers";
const p = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network", 5042002);
const tr = new ethers.Contract("0x1cc2ac9d45c7B1d261C05df5bf16E778B93DAA35", ["function tasks(bytes32) view returns (bytes32,address,uint256,uint256,uint256,address,uint8,uint256)"], p);
const r = await (await fetch("https://polaris-agent-runtime-production.up.railway.app/api/index")).json();
const NAMES=["OPEN","ASSIGNED","IN_PROGRESS","COMPLETED","SETTLED","CANCELLED"];
const t = r.tasks.find(x=>x.title.startsWith("Fix responsive"));
if(t){const oc=await tr.tasks(t.taskId);console.log(`"${t.title.slice(0,30)}" chain=${NAMES[Number(oc[6])]} assigned=${oc[5].slice(0,10)} attestation=${t.attestation?JSON.stringify(t.attestation):'none'}`);}
