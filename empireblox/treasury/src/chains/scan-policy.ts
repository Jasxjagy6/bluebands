export function scanIntervalMs(chainId:string):number{
  return chainId==='BSC'?5000:chainId==='SOL'?30000:15000;
}
