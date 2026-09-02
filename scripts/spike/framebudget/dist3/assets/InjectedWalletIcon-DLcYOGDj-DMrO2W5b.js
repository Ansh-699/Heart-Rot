import{o as e}from"./rolldown-runtime-C_s2cVnS.js";import{n as t,t as n}from"./jsx-runtime-CMaQg7dW.js";import{d as r,ft as i,ut as a}from"./ModalFooter-FDXOM0ZR-dLPfJ137.js";import{t as o}from"./LinkPasskeyScreen-kLHXLgOb-wGCgO3mL.js";var s=n(),c=e(t());function l({title:e,titleId:t,...n},r){return c.createElement(`svg`,Object.assign({xmlns:`http://www.w3.org/2000/svg`,fill:`none`,viewBox:`0 0 24 24`,strokeWidth:1.5,stroke:`currentColor`,"aria-hidden":`true`,"data-slot":`icon`,ref:r,"aria-labelledby":t},n),e?c.createElement(`title`,{id:t},e):null,c.createElement(`path`,{strokeLinecap:`round`,strokeLinejoin:`round`,d:`M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3`}))}var u=c.forwardRef(l);i.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 24px;
  padding-bottom: 24px;
`;var d=i.div`
  width: 24px;
  height: 24px;
  display: flex;
  justify-content: center;
  align-items: center;

  svg {
    border-radius: var(--privy-border-radius-sm);
  }
`,f=i.div`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: 8px;
`,p=i.div`
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 0 16px;
  border-width: 1px !important;
  border-radius: 12px;
  cursor: text;

  &:focus-within {
    border-color: var(--privy-color-accent);
  }
`;i.div`
  font-size: 42px !important;
`;var m=i.input`
  background-color: var(--privy-color-background);
  width: 100%;

  &:focus {
    outline: none !important;
    border: none !important;
    box-shadow: none !important;
  }

  && {
    font-size: 26px;
  }
`;i(m)`
  && {
    font-size: 42px;
  }
`,i.button`
  cursor: pointer;
  padding-left: 4px;
`;var h=i.div`
  font-size: 18px;
`,g=i.div`
  font-size: 12px;
  color: var(--privy-color-foreground-3);
  // we need this container to maintain a static height if there's no content
  height: 20px;
`;i.div`
  display: flex;
  flex-direction: row;
  line-height: 22px;
  font-size: 16px;
  text-align: center;
  svg {
    margin-right: 6px;
    margin: auto;
  }
`,i(o)`
  margin-top: 16px;
`;var _=a`
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
`;i(r)`
  border-radius: var(--privy-border-radius-md) !important;
  animation: ${_} 0.3s ease-in-out;
`,i.div``,i.a`
  && {
    color: var(--privy-color-accent);
  }

  cursor: pointer;
`;var v=({icon:e,name:t})=>typeof e==`string`?(0,s.jsx)(`img`,{alt:`${t||`wallet`} logo`,src:e,style:{height:24,width:24,borderRadius:4}}):e===void 0?(0,s.jsx)(u,{style:{height:24,width:24}}):e?(0,s.jsx)(e,{style:{height:24,width:24}}):null;export{d as a,u as c,g as i,f as n,p as o,h as r,m as s,v as t};