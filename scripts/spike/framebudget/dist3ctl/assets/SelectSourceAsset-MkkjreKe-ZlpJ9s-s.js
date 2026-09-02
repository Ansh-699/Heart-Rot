import{o as e}from"./rolldown-runtime-C_s2cVnS.js";import{n as t,t as n}from"./jsx-runtime-CMaQg7dW.js";import{M as r,ft as i}from"./ModalFooter-FDXOM0ZR-dLPfJ137.js";import{t as a}from"./createLucideIcon-DmNNZQFn.js";import{t as o}from"./ScreenLayout-BZAQ9cdJ-CYOQxane.js";var s=a(`chevron-down`,[[`path`,{d:`m6 9 6 6 6-6`,key:`qrunsl`}]]),c=n(),l=e(t(),1),u=({currency:e=`usd`,value:t,onChange:n,inputMode:i=`decimal`,autoFocus:a})=>{let[o,s]=(0,l.useState)(`0`),[u,d]=(0,l.useState)(null),g=(0,l.useRef)(null),_=(0,l.useRef)(null),v=t??o,y=r[e]?.symbol??`$`,b=v.length>9?`small`:v.length>6?`compact`:`default`;(0,l.useLayoutEffect)((()=>{let e=_.current?.offsetWidth;d(e?Math.ceil(e)+2:null)}),[b,v]);let x=(0,l.useCallback)((e=>{let t=e.target.value,r=(t=t.replace(/[^\d.]/g,``)).split(`.`);r.length>2&&(t=r[0]+`.`+r.slice(1).join(``));let[i=``,a]=t.split(`.`),o=i.replace(/^0+(?=\d)/,``);((t=a===void 0?o||`0`:`${o||`0`}.${a}`)===``||t===`.`)&&(t=`0`),n?n(t):s(t)}),[n]),S=(0,l.useCallback)((e=>{!([`Delete`,`Backspace`,`Tab`,`Escape`,`Enter`,`.`,`ArrowLeft`,`ArrowRight`,`ArrowUp`,`ArrowDown`,`Home`,`End`].includes(e.key)||(e.ctrlKey||e.metaKey)&&[`a`,`c`,`v`,`x`].includes(e.key.toLowerCase()))&&(e.key>=`0`&&e.key<=`9`||e.preventDefault())}),[]);return(0,c.jsxs)(f,{$size:b,onClick:()=>g.current?.focus(),children:[(0,c.jsx)(h,{$size:b,children:y}),(0,c.jsx)(p,{ref:g,type:`text`,inputMode:i,value:v,onChange:x,onKeyDown:S,autoFocus:a,placeholder:`0`,"aria-label":`Amount`,style:u?{width:`${u}px`}:void 0}),(0,c.jsx)(m,{ref:_,"aria-hidden":`true`,children:v}),(0,c.jsx)(h,{$size:b,style:{opacity:0},children:y})]})},d=({selectedAsset:e,onEditSourceAsset:t})=>{let{icon:n}=r[e];return(0,c.jsxs)(g,{onClick:t,children:[(0,c.jsx)(_,{children:n}),(0,c.jsx)(v,{children:e.toLocaleUpperCase()}),(0,c.jsx)(y,{children:(0,c.jsx)(s,{})})]})},f=i.span`
  position: relative;
  background-color: var(--privy-color-background);
  width: 100%;
  box-sizing: border-box;
  text-align: center;
  font-kerning: none;
  font-feature-settings: 'calt' off;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  cursor: pointer;

  && {
    color: var(--privy-color-foreground);
    font-size: ${({$size:e})=>e===`small`?`2.25rem`:e===`compact`?`3rem`:`3.75rem`};
    font-style: normal;
    font-weight: 600;
    line-height: 5.375rem;
  }
`,p=i.input`
  appearance: none;
  align-self: flex-start;
  min-width: 1ch;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  text-align: left;
  caret-color: currentColor;

  &:focus {
    outline: none !important;
    border: none !important;
    box-shadow: none !important;
  }
`,m=i.span`
  position: absolute;
  visibility: hidden;
  white-space: pre;
  pointer-events: none;
`,h=i.span`
  color: var(--privy-color-foreground);
  font-kerning: none;
  font-feature-settings: 'calt' off;
  font-size: ${({$size:e})=>e===`small`?`0.75rem`:e===`compact`?`0.875rem`:`1rem`};
  font-style: normal;
  font-weight: 600;
  line-height: 1.5rem;
  margin-top: 0.75rem;
`,g=i.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: auto;
  gap: 0.5rem;
  border: 1px solid var(--privy-color-border-default);
  border-radius: var(--privy-border-radius-full);

  && {
    margin: auto;
    padding: 0.5rem 1rem;
  }
`,_=i.div`
  svg {
    width: 1rem;
    height: 1rem;
    border-radius: var(--privy-border-radius-full);
    overflow: hidden;
    border: solid 0.1px var(--privy-color-border-default);
  }
`,v=i.span`
  color: var(--privy-color-foreground);
  font-kerning: none;
  font-feature-settings: 'calt' off;
  font-size: 0.875rem;
  font-style: normal;
  font-weight: 500;
  line-height: 1.375rem;
`,y=i.div`
  color: var(--privy-color-foreground);

  svg {
    width: 1.25rem;
    height: 1.25rem;
  }
`,b=({opts:e,isLoading:t,onSelectSource:n})=>(0,c.jsx)(o,{showClose:!1,showBack:!0,onBack:()=>n(e.source.selectedAsset),title:`Select currency`,children:(0,c.jsx)(x,{children:e.source.assets.map((e=>{let{icon:i,name:a}=r[e];return(0,c.jsx)(S,{onClick:()=>n(e),disabled:t,children:(0,c.jsxs)(C,{children:[(0,c.jsx)(w,{children:i}),(0,c.jsxs)(T,{children:[(0,c.jsx)(E,{children:a}),(0,c.jsx)(D,{children:e.toLocaleUpperCase()})]})]})},e)}))})}),x=i.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
  max-height: 20.875rem;
  overflow-y: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
`,S=i.button`
  border-color: var(--privy-color-border-default);
  border-width: 1px;
  border-radius: var(--privy-border-radius-mdlg);
  border-style: solid;
  display: flex;

  && {
    padding: 0.75rem 1rem;
  }
`,C=i.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  width: 100%;
`,w=i.div`
  svg {
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--privy-border-radius-full);
    overflow: hidden;
    border: solid 0.1px var(--privy-color-border-default);
  }
`,T=i.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.125rem;
`,E=i.span`
  color: var(--privy-color-foreground);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25rem;
`,D=i.span`
  color: var(--privy-color-foreground-3);
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1.125rem;
`;export{d as n,b as r,u as t};