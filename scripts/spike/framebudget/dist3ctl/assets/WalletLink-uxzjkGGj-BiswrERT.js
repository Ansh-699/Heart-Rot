import{t as e}from"./jsx-runtime-CMaQg7dW.js";import{Vt as t,ft as n}from"./ModalFooter-FDXOM0ZR-dLPfJ137.js";import{g as r}from"./_esm-HjeVEJFj.js";import{a as i,n as a,r as o,t as s}from"./ethers-ComuOzvK-BDA-iX7t.js";import{n as c,r as l}from"./transaction-BNTP-bFm-U-b7HwKA.js";var u=e(),d=({weiQuantities:e,tokenPrice:t,tokenSymbol:n})=>{let r=a(e),o=t?i(r,t):void 0,c=s(r,n);return(0,u.jsx)(m,{children:o||c})},f=({weiQuantities:e,tokenPrice:t,tokenSymbol:n})=>{let r=a(e),o=t?i(r,t):void 0,c=s(r,n);return(0,u.jsx)(m,{children:o?(0,u.jsxs)(u.Fragment,{children:[(0,u.jsx)(h,{children:`USD`}),o===`<$0.01`?(0,u.jsxs)(_,{children:[(0,u.jsx)(g,{children:`<`}),`$0.01`]}):o]}):c})},p=({quantities:e,tokenPrice:t,tokenSymbol:n=`SOL`,tokenDecimals:i=9})=>{let a=e.reduce(((e,t)=>e+t),0n),o=t&&n===`SOL`&&i===9?l(a,t):void 0,s=n===`SOL`&&i===9?c(a):`${r(a,i)} ${n}`;return(0,u.jsx)(m,{children:o?(0,u.jsx)(u.Fragment,{children:o===`<$0.01`?(0,u.jsxs)(_,{children:[(0,u.jsx)(g,{children:`<`}),`$0.01`]}):o}):s})},m=n.span`
  font-size: 14px;
  line-height: 140%;
  display: flex;
  gap: 4px;
  align-items: center;
`,h=n.span`
  font-size: 12px;
  line-height: 12px;
  color: var(--privy-color-foreground-3);
`,g=n.span`
  font-size: 10px;
`,_=n.span`
  display: flex;
  align-items: center;
`;function v(e,t){return`https://explorer.solana.com/account/${e}?chain=${t}`}var y=e=>(0,u.jsx)(b,{href:e.chainType===`ethereum`?o(e.chainId,e.walletAddress):v(e.walletAddress,e.chainId),target:`_blank`,children:t(e.walletAddress)}),b=n.a`
  &:hover {
    text-decoration: underline;
  }
`;export{d as i,p as n,f as r,y as t};