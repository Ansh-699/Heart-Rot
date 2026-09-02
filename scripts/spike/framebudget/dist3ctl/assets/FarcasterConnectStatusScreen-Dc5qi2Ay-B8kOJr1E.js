import{o as e}from"./rolldown-runtime-C_s2cVnS.js";import{n as t,t as n}from"./jsx-runtime-CMaQg7dW.js";import{Jt as r,en as i,ft as a,jt as o,lt as s,nn as c,nt as l,o as u,on as d,qt as f,un as p}from"./ModalFooter-FDXOM0ZR-dLPfJ137.js";import{n as m,t as h}from"./copy-CxLYhMVw.js";import{t as g}from"./ScreenLayout-BZAQ9cdJ-CYOQxane.js";import{t as _}from"./shouldProceedtoEmbeddedWalletCreationFlow-CrZNVDLd-B4NCWoB1.js";import{t as v}from"./browser-CR3Phzsa.js";import{t as y}from"./QrCode-RT6d3bP5-C4YappNd.js";import{t as b}from"./farcaster-DPlSjvF5-fDPVMv4F.js";import{t as x}from"./LabelXs-oqZNqbm_-DY6K6iWS.js";var S=e(o(),1),C=n(),w=e(t(),1),T=e=>{let[t,n]=(0,w.useState)(!1);return(0,C.jsx)(E,{color:e.color,href:e.url,target:`_blank`,rel:`noreferrer noopener`,onClick:()=>{n(!0),setTimeout((()=>n(!1)),1500)},justOpened:t,children:e.text})},E=a.a`
  display: flex;
  align-items: center;
  gap: 6px;

  && {
    margin: 8px 2px;
    font-size: 14px;
    color: ${e=>e.justOpened?`var(--privy-color-foreground)`:e.color||`var(--privy-color-foreground-3)`};
    font-weight: ${e=>e.justOpened?`medium`:`normal`};
    transition: color 350ms ease;

    :focus,
    :active {
      background-color: transparent;
      border: none;
      outline: none;
      box-shadow: none;
    }

    :hover {
      color: ${e=>e.justOpened?`var(--privy-color-foreground)`:`var(--privy-color-foreground-2)`};
    }

    :active {
      color: 'var(--privy-color-foreground)';
      font-weight: medium;
    }

    @media (max-width: 440px) {
      margin: 12px 2px;
    }
  }

  svg {
    width: 14px;
    height: 14px;
  }
`;v();var D=a.div`
  width: 100%;
`,O=a.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem;
  height: 56px;
  background: ${e=>e.$disabled?`var(--privy-color-background-2)`:`var(--privy-color-background)`};
  border: 1px solid var(--privy-color-foreground-4);
  border-radius: var(--privy-border-radius-md);

  &:hover {
    border-color: ${e=>e.$disabled?`var(--privy-color-foreground-4)`:`var(--privy-color-foreground-3)`};
  }
`,k=a.div`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
`,A=a.span`
  display: block;
  font-size: 16px;
  line-height: 24px;
  color: ${e=>e.$disabled?`var(--privy-color-foreground-2)`:`var(--privy-color-foreground)`};
  overflow: hidden;
  text-overflow: ellipsis;
  /* Use single-line truncation without nowrap to respect container width */
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  word-break: break-all;

  @media (min-width: 441px) {
    font-size: 14px;
    line-height: 20px;
  }
`,j=a(A)`
  color: var(--privy-color-foreground-3);
  font-style: italic;
`,M=a(x)`
  margin-bottom: 0.5rem;
`,N=a(u)`
  && {
    gap: 0.375rem;
    font-size: 14px;
    flex-shrink: 0;
  }
`,P=({value:e,title:t,placeholder:n,className:r,showCopyButton:i=!0,truncate:a,maxLength:o=40,disabled:s=!1})=>{let[c,l]=(0,w.useState)(!1),u=a&&e?((e,t,n)=>{if((e=e.startsWith(`https://`)?e.slice(8):e).length<=n)return e;if(t===`middle`){let t=Math.ceil(n/2)-2,r=Math.floor(n/2)-1;return`${e.slice(0,t)}...${e.slice(-r)}`}return`${e.slice(0,n-3)}...`})(e,a,o):e;return(0,w.useEffect)((()=>{if(c){let e=setTimeout((()=>l(!1)),3e3);return()=>clearTimeout(e)}}),[c]),(0,C.jsxs)(D,{className:r,children:[t&&(0,C.jsx)(M,{children:t}),(0,C.jsxs)(O,{$disabled:s,children:[(0,C.jsx)(k,{children:e?(0,C.jsx)(A,{$disabled:s,title:e,children:u}):(0,C.jsx)(j,{$disabled:s,children:n||`No value`})}),i&&e&&(0,C.jsx)(N,{onClick:function(t){t.stopPropagation(),navigator.clipboard.writeText(e).then((()=>l(!0))).catch(console.error)},size:`sm`,children:(0,C.jsxs)(C.Fragment,c?{children:[`Copied`,(0,C.jsx)(m,{size:14})]}:{children:[`Copy`,(0,C.jsx)(h,{size:14})]})})]})]})},F=({connectUri:e,loading:t,success:n,errorMessage:r,onBack:i,onClose:a,onOpenFarcaster:o})=>(0,C.jsx)(g,S.isMobile||t?S.isIOS?{title:r?r.message:`Sign in with Farcaster`,subtitle:r?r.detail:`To sign in with Farcaster, please open the Farcaster app.`,icon:b,iconVariant:`loading`,iconLoadingStatus:{success:n,fail:!!r},primaryCta:e&&o?{label:`Open Farcaster app`,onClick:o}:void 0,onBack:i,onClose:a,watermark:!0}:{title:r?r.message:`Signing in with Farcaster`,subtitle:r?r.detail:`This should only take a moment`,icon:b,iconVariant:`loading`,iconLoadingStatus:{success:n,fail:!!r},onBack:i,onClose:a,watermark:!0,children:e&&S.isMobile&&(0,C.jsx)(L,{children:(0,C.jsx)(T,{text:`Take me to Farcaster`,url:e,color:`#8a63d2`})})}:{title:`Sign in with Farcaster`,subtitle:`Scan with your phone's camera to continue.`,onBack:i,onClose:a,watermark:!0,children:(0,C.jsxs)(R,{children:[(0,C.jsx)(z,{children:e?(0,C.jsx)(y,{url:e,size:275,squareLogoElement:b}):(0,C.jsx)(H,{children:(0,C.jsx)(l,{})})}),(0,C.jsxs)(B,{children:[(0,C.jsx)(V,{children:`Or copy this link and paste it into a phone browser to open the Farcaster app.`}),e&&(0,C.jsx)(P,{value:e,truncate:`end`,maxLength:30,showCopyButton:!0,disabled:!0})]})]})}),I={component:()=>{let{authenticated:e,logout:t,ready:n,user:a}=d(),{lastScreen:o,navigate:l,navigateBack:u,setModalData:m}=s(),h=c(),{getAuthFlow:g,loginWithFarcaster:v,closePrivyModal:y,createAnalyticsEvent:b}=p(),[x,S]=(0,w.useState)(void 0),[T,E]=(0,w.useState)(!1),[D,O]=(0,w.useState)(!1),k=(0,w.useRef)([]),A=g(),j=A?.meta.connectUri;return(0,w.useEffect)((()=>{let e=Date.now(),t=setInterval((async()=>{let n=await A.pollForReady.execute(),i=Date.now()-e;if(n){clearInterval(t),E(!0);try{await v(),O(!0)}catch(e){let t={retryable:!1,message:`Authentication failed`};if(e?.privyErrorCode===r.ALLOWLIST_REJECTED)return void l(`AllowlistRejectionScreen`);if(e?.privyErrorCode===r.USER_LIMIT_REACHED)return console.error(new f(e).toString()),void l(`UserLimitReachedScreen`);if(e?.privyErrorCode===r.USER_DOES_NOT_EXIST)return void l(`AccountNotFoundScreen`);if(e?.privyErrorCode===r.LINKED_TO_ANOTHER_USER)t.detail=e.message??`This account has already been linked to another user.`;else{if(e?.privyErrorCode===r.ACCOUNT_TRANSFER_REQUIRED&&e.data?.data?.nonce)return m({accountTransfer:{nonce:e.data?.data?.nonce,account:e.data?.data?.subject,displayName:e.data?.data?.account?.displayName,linkMethod:`farcaster`,embeddedWalletAddress:e.data?.data?.otherUser?.embeddedWalletAddress,farcasterEmbeddedAddress:e.data?.data?.otherUser?.farcasterEmbeddedAddress}}),void l(`LinkConflictScreen`);e?.privyErrorCode===r.INVALID_CREDENTIALS?(t.retryable=!0,t.detail=`Something went wrong. Try again.`):e?.privyErrorCode===r.TOO_MANY_REQUESTS&&(t.detail=`Too many requests. Please wait before trying again.`)}S(t)}}else i>12e4&&(clearInterval(t),S({retryable:!0,message:`Authentication failed`,detail:`The request timed out. Try again.`}))}),2e3);return()=>{clearInterval(t),k.current.forEach((e=>clearTimeout(e)))}}),[]),(0,w.useEffect)((()=>{if(n&&e&&D&&a){if(h?.legal.requireUsersAcceptTerms&&!a.hasAcceptedTerms){let e=setTimeout((()=>{l(`AffirmativeConsentScreen`)}),i);return()=>clearTimeout(e)}D&&(_(a,h.embeddedWallets)?k.current.push(setTimeout((()=>{m({createWallet:{onSuccess:()=>{},onFailure:e=>{console.error(e),b({eventName:`embedded_wallet_creation_failure_logout`,payload:{error:e,screen:`FarcasterConnectStatusScreen`}}),t()},callAuthOnSuccessOnClose:!0}}),l(`EmbeddedWalletOnAccountCreateScreen`)}),1400)):k.current.push(setTimeout((()=>y({shouldCallAuthOnSuccess:!0,isSuccess:!0})),1400)))}}),[D,n,e,a]),(0,C.jsx)(F,{connectUri:j,loading:T,success:D,errorMessage:x,onBack:o?u:void 0,onClose:y,onOpenFarcaster:()=>{j&&(window.location.href=j)}})}},L=a.div`
  margin-top: 24px;
`,R=a.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
`,z=a.div`
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 275px;
`,B=a.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
`,V=a.div`
  font-size: 0.875rem;
  text-align: center;
  color: var(--privy-color-foreground-2);
`,H=a.div`
  position: relative;
  width: 82px;
  height: 82px;
`;export{I as FarcasterConnectStatusScreen,I as default,F as FarcasterConnectStatusView};