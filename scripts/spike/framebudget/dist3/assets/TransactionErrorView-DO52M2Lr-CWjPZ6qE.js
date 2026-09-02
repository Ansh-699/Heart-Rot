import{o as e}from"./rolldown-runtime-C_s2cVnS.js";import{n as t,t as n}from"./jsx-runtime-CMaQg7dW.js";import{An as r,a as i,ft as a,i as o,jn as s,kn as c,n as l,nn as u,t as d,u as f,un as p,wn as m}from"./ModalFooter-FDXOM0ZR-dLPfJ137.js";import{cn as h}from"./ccip-BtUZ5Weq.js";import{t as ee}from"./useActiveWallet-Cx-foFVv-DOWsmlB3.js";import{c as g}from"./ethers-ComuOzvK-BDA-iX7t.js";import{n as _,t as v}from"./Checkbox-BhNoOKjX-DyZw7q_h.js";import{t as y}from"./ErrorMessage-D8VaAP5m-D6SKotoN.js";import{a as b,i as x,n as S,r as C,t as w}from"./Value-DTgR824E-BBhNI3LJ.js";import{t as T}from"./LoadingSkeleton-BMsgO5PV-BYAAylho.js";import{t as E}from"./Subtitle-CV-2yKE4-CXF03rHh.js";import{r as D,t as O}from"./shared-FM0rljBt-B4wtftJc.js";import{t as k}from"./Address-P0fi9aXn-CJn4Yc_Z.js";import{t as A}from"./LabelXs-oqZNqbm_-DY6K6iWS.js";import{t as j}from"./WalletInfoCard-D_KcqTI9-DxKqpxQ8.js";import{t as M}from"./WarningBanner-ZZqCEtZK-CdVoO6RC.js";var N=e(t()),P=n(),F=function(e){return e.OAUTH_ACCOUNT_SUSPENDED=`oauth_account_suspended`,e.MISSING_OR_INVALID_PRIVY_APP_ID=`missing_or_invalid_privy_app_id`,e.MISSING_OR_INVALID_PRIVY_CLIENT_ID=`missing_or_invalid_privy_client_id`,e.MISSING_OR_INVALID_PRIVY_ACCOUNT_ID=`missing_or_invalid_privy_account_id`,e.MISSING_OR_INVALID_TOKEN=`missing_or_invalid_token`,e.MISSING_MFA_ENROLLMENT=`missing_mfa_enrollment`,e.MISSING_OR_INVALID_MFA=`missing_or_invalid_mfa`,e.EXPIRED_OR_INVALID_MFA_TOKEN=`expired_or_invalid_mfa_token`,e.INVALID_DATA=`invalid_data`,e.INVALID_CREDENTIALS=`invalid_credentials`,e.PASSKEY_NOT_REGISTERED=`passkey_not_registered`,e.INVALID_CAPTCHA=`invalid_captcha`,e.LINKED_TO_ANOTHER_USER=`linked_to_another_user`,e.ALLOWLIST_REJECTED=`allowlist_rejected`,e.CANNOT_UNLINK_EMBEDDED_WALLET=`cannot_unlink_embedded_wallet`,e.CANNOT_UNLINK_SOLE_ACCOUNT=`cannot_unlink_sole_account`,e.CANNOT_LINK_MORE_OF_TYPE=`cannot_link_more_of_type`,e.LINKED_ACCOUNT_NOT_FOUND=`linked_account_not_found`,e.TOO_MANY_REQUESTS=`too_many_requests`,e.RESOURCE_CONFLICT=`resource_conflict`,e.INVALID_ORIGIN=`invalid_origin`,e.MISSING_ORIGIN=`missing_origin`,e.INVALID_NATIVE_APP_ID=`invalid_native_app_id`,e.TOKEN_ALREADY_USED=`token_already_used`,e.ALREADY_LOGGED_OUT=`already_logged_out`,e.NOT_SUPPORTED=`not_supported`,e.USER_UNSUBSCRIBED=`user_unsubscribed`,e.MAX_APPS_REACHED=`max_apps_reached`,e.USER_LIMIT_REACHED=`max_accounts_reached`,e.DEVICE_REVOKED=`device_revoked`,e.WALLET_PASSWORD_EXISTS=`wallet_password_exists`,e.OAUTH_STATE_MISMATCH=`oauth_state_mismatch`,e.MAX_DENYLIST_ENTRIES_REACHED=`max_denylist_entries_reached`,e.MAX_TEST_ACCOUNTS_REACHED=`max_test_accounts_reached`,e.DISALLOWED_LOGIN_METHOD=`disallowed_login_method`,e.DISALLOWED_PLUS_EMAIL=`disallowed_plus_email`,e.DISALLOWED_RECOVERY_METHOD=`disallowed_recovery_method`,e.LEGACY_DASHBOARD_LOGIN_CONFIGURATION=`legacy_dashboard_login_configuration`,e.CANNOT_SET_PASSWORD=`cannot_set_password`,e.INVALID_PKCE_PARAMETERS=`invalid_pkce_parameters`,e.INVALID_APP_URL_SCHEME_CONFIGURATION=`invalid_app_url_scheme_configuration`,e.CROSS_APP_CONNECTION_NOT_ALLOWED=`cross_app_connection_not_allowed`,e.USER_DOES_NOT_EXIST=`user_does_not_exist`,e.ALREADY_EXISTS=`resource_already_exists`,e.ACCOUNT_TRANSFER_REQUIRED=`account_transfer_required`,e.USER_HAS_NOT_DELEGATED_WALLET=`user_has_not_delegated_wallet`,e.FEATURE_NOT_ENABLED=`feature_not_enabled`,e.ONRAMP_MINIMUM_IDENTITY_VERIFICATION_REQUIRED=`onramp_minimum_identity_verification_required`,e.ONRAMP_IDENTITY_VERIFICATION_REQUIRED=`onramp_identity_verification_required`,e.ONRAMP_DOCUMENT_VERIFICATION_REQUIRED=`onramp_document_verification_required`,e.ONRAMP_UNSUPPORTED_INFORMATION=`onramp_unsupported_information`,e.ONRAMP_TRANSACTION_LIMIT_REACHED=`transaction_limit_reached`,e.ONRAMP_QUOTE_EXPIRED=`onramp_quote_expired`,e.INSUFFICIENT_FUNDS=`insufficient_funds`,e.TRANSACTION_BROADCAST_FAILURE=`transaction_broadcast_failure`,e.TRANSACTION_EXECUTION_FAILURE=`transaction_execution_failure`,e.INVALID_SOLANA_TRANSACTION=`invalid_solana_transaction`,e.INVALID_POLICY_FORMAT=`invalid_policy_format`,e.INVALID_AGGREGATION_FORMAT=`invalid_aggregation_format`,e.POLICY_VIOLATION=`policy_violation`,e.AUTHORIZATION_KEY_HAS_ASSOCIATED_WALLETS=`authorization_key_has_associated_wallets`,e.COMPLIANCE_BLOCKED=`compliance_blocked`,e.INVALID_REQUEST=`invalid_request`,e.SIGNUP_DISABLED=`signup_disabled`,e.INVALID_STATE=`invalid_state`,e.WALLET_ENTITY_ASSIGNMENT_FAILED=`wallet_entity_assignment_failed`,e.WALLET_ENTITY_LIMIT_EXCEEDED=`wallet_entity_limit_exceeded`,e.WALLET_ENTITY_ALREADY_SET=`wallet_entity_already_set`,e}({});r({error:s(),cause:s().optional(),code:c(F).optional()});function I({title:e,titleId:t,...n},r){return N.createElement(`svg`,Object.assign({xmlns:`http://www.w3.org/2000/svg`,fill:`none`,viewBox:`0 0 24 24`,strokeWidth:1.5,stroke:`currentColor`,"aria-hidden":`true`,"data-slot":`icon`,ref:r,"aria-labelledby":t},n),e?N.createElement(`title`,{id:t},e):null,N.createElement(`path`,{strokeLinecap:`round`,strokeLinejoin:`round`,d:`M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3`}))}var te=N.forwardRef(I);function L({title:e,titleId:t,...n},r){return N.createElement(`svg`,Object.assign({xmlns:`http://www.w3.org/2000/svg`,fill:`none`,viewBox:`0 0 24 24`,strokeWidth:1.5,stroke:`currentColor`,"aria-hidden":`true`,"data-slot":`icon`,ref:r,"aria-labelledby":t},n),e?N.createElement(`title`,{id:t},e):null,N.createElement(`path`,{strokeLinecap:`round`,strokeLinejoin:`round`,d:`m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z`}))}var R=N.forwardRef(L);function z({title:e,titleId:t,...n},r){return N.createElement(`svg`,Object.assign({xmlns:`http://www.w3.org/2000/svg`,fill:`none`,viewBox:`0 0 24 24`,strokeWidth:1.5,stroke:`currentColor`,"aria-hidden":`true`,"data-slot":`icon`,ref:r,"aria-labelledby":t},n),e?N.createElement(`title`,{id:t},e):null,N.createElement(`path`,{strokeLinecap:`round`,strokeLinejoin:`round`,d:`M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z`}))}var B=N.forwardRef(z);function V({title:e,titleId:t,...n},r){return N.createElement(`svg`,Object.assign({xmlns:`http://www.w3.org/2000/svg`,fill:`none`,viewBox:`0 0 24 24`,strokeWidth:1.5,stroke:`currentColor`,"aria-hidden":`true`,"data-slot":`icon`,ref:r,"aria-labelledby":t},n),e?N.createElement(`title`,{id:t},e):null,N.createElement(`path`,{strokeLinecap:`round`,strokeLinejoin:`round`,d:`M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z`}))}var H=N.forwardRef(V),U=({children:e,theme:t,className:n})=>(0,P.jsxs)(ne,{$theme:t,className:n,children:[(0,P.jsx)(H,{width:`16px`,height:`16px`,color:`var(--privy-color-icon-error)`,strokeWidth:2,style:{flexShrink:0}}),(0,P.jsx)(re,{$theme:t,children:e})]}),ne=a.div`
  display: flex;
  gap: 0.5rem;
  background-color: var(--privy-color-error-bg);
  border: 1px solid var(--privy-color-border-error);
  align-items: flex-start;
  padding: 0.75rem;
  border-radius: 0.5rem;
  overflow: clip;
  width: 100%;
`,re=a.div`
  color: ${e=>e.$theme===`dark`?`var(--privy-color-foreground-2)`:`var(--privy-color-foreground)`};
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1.125rem;
  flex: 1;
  text-align: left;
  font-feature-settings:
    'calt' 0,
    'kern' 0;
`,ie=a(w)`
  cursor: pointer;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  color: var(--privy-color-accent);
  svg {
    fill: var(--privy-color-accent);
  }
`,ae=({iconUrl:e,value:t,symbol:n,usdValue:r,nftName:i,nftCount:a,decimals:o,$isLoading:s})=>{if(s)return(0,P.jsx)(W,{$isLoading:s});let c=t&&r&&o?function(e,t,n){let r=parseFloat(e),i=parseFloat(n);if(r===0||i===0||Number.isNaN(r)||Number.isNaN(i))return e;let a=Math.ceil(-Math.log10(.01/(i/r))),o=10**(a=Math.max(a=Math.min(a,t),1)),s=+(Math.floor(r*o)/o).toFixed(a).replace(/\.?0+$/,``);return Intl.NumberFormat(void 0,{maximumFractionDigits:t}).format(s)}(t,o,r):t;return(0,P.jsxs)(`div`,{children:[(0,P.jsxs)(W,{$isLoading:s,children:[e&&(0,P.jsx)(K,{src:e,alt:`Token icon`}),a&&a>1?a+`x`:void 0,` `,i,c,` `,n]}),r&&(0,P.jsxs)(G,{$isLoading:s,children:[`$`,r]})]})},W=a.span`
  color: var(--privy-color-foreground);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.375rem;
  word-break: break-all;
  text-align: right;
  display: flex;
  justify-content: flex-end;

  /**
   * @NOTE This is a code smell anti-pattern for styling components.
   * We are mixing JSX definitions with styled-components CSS definitions.
   * This is not ideal and should be refactored in the future to separate concerns.
   * This is also hard to read, as it makes it difficult to understand the structure
   * of the component and its styles by viewing the JSX.
   */

  ${T}
`,G=a.span`
  color: var(--privy-color-foreground-2);
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  word-break: break-all;
  text-align: right;
  display: flex;
  justify-content: flex-end;

  ${T}
`,K=a.img`
  height: 14px;
  width: 14px;
  margin-right: 4px;
  object-fit: contain;
`,oe=e=>{let{chain:t,transactionDetails:n,isTokenContractInfoLoading:r,symbol:i}=e,{action:a,functionName:o}=n;return(0,P.jsx)(O,{children:(0,P.jsxs)(b,{children:[a!==`transaction`&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Action`}),(0,P.jsx)(S,{children:o})]}),o===`mint`&&`args`in n&&n.args.filter((e=>e)).map(((e,n)=>(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Param ${n}`}),(0,P.jsx)(S,{children:typeof e==`string`&&h(e)?(0,P.jsx)(k,{address:e,url:t?.blockExplorers?.default?.url,showCopyIcon:!1}):e?.toString()})]},n))),o===`setApprovalForAll`&&n.operator&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Operator`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:n.operator,url:t?.blockExplorers?.default?.url,showCopyIcon:!1})})]}),o===`setApprovalForAll`&&n.approved!==void 0&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Set approval to`}),(0,P.jsx)(S,{children:n.approved?`true`:`false`})]}),o===`transfer`||o===`transferWithMemo`||o===`transferFrom`||o===`safeTransferFrom`||o===`approve`?(0,P.jsxs)(P.Fragment,{children:[`formattedAmount`in n&&n.formattedAmount&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Amount`}),(0,P.jsxs)(S,{$isLoading:r,children:[n.formattedAmount,` `,i]})]}),`tokenId`in n&&n.tokenId&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token ID`}),(0,P.jsx)(S,{children:n.tokenId.toString()})]})]}):null,o===`safeBatchTransferFrom`&&(0,P.jsxs)(P.Fragment,{children:[`amounts`in n&&n.amounts&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Amounts`}),(0,P.jsx)(S,{children:n.amounts.join(`, `)})]}),`tokenIds`in n&&n.tokenIds&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token IDs`}),(0,P.jsx)(S,{children:n.tokenIds.join(`, `)})]})]}),o===`approve`&&n.spender&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Spender`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:n.spender,url:t?.blockExplorers?.default?.url,showCopyIcon:!1})})]}),(o===`transferFrom`||o===`safeTransferFrom`||o===`safeBatchTransferFrom`)&&n.transferFrom&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Transferring from`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:n.transferFrom,url:t?.blockExplorers?.default?.url,showCopyIcon:!1})})]}),(o===`transferFrom`||o===`safeTransferFrom`||o===`safeBatchTransferFrom`)&&n.transferTo&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Transferring to`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:n.transferTo,url:t?.blockExplorers?.default?.url,showCopyIcon:!1})})]})]})})},se=({variant:e,setPreventMaliciousTransaction:t,colorScheme:n=`light`,preventMaliciousTransaction:r})=>e===`warn`?(0,P.jsx)(q,{children:(0,P.jsxs)(M,{theme:n,children:[(0,P.jsx)(`span`,{style:{fontWeight:`500`},children:`Warning: Suspicious transaction`}),(0,P.jsx)(`br`,{}),`This has been flagged as a potentially deceptive request. Approving could put your assets or funds at risk.`]})}):e===`error`?(0,P.jsx)(P.Fragment,{children:(0,P.jsxs)(q,{children:[(0,P.jsx)(U,{theme:n,children:(0,P.jsxs)(`div`,{children:[(0,P.jsx)(`strong`,{children:`This is a malicious transaction`}),(0,P.jsx)(`br`,{}),`This transaction transfers tokens to a known malicious address. Proceeding may result in the loss of valuable assets.`]})}),(0,P.jsxs)(J,{children:[(0,P.jsx)(v,{color:`var(--privy-color-error)`,checked:!r,readOnly:!0,onClick:()=>t(!r)}),(0,P.jsx)(`span`,{children:`I understand and want to proceed anyways.`})]})]})}):null,q=a.div`
  margin-top: 1.5rem;
`,J=a.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
`,ce=({transactionIndex:e,maxIndex:t})=>typeof e!=`number`||t===0?``:` (${e+1} / ${t+1})`,le=({img:e,submitError:t,prepareError:n,onClose:r,action:a,title:s,subtitle:c,to:l,tokenAddress:p,network:m,missingFunds:h,fee:_,from:v,cta:T,disabled:O,chain:A,isSubmitting:j,isPreparing:M,isTokenPriceLoading:F,isTokenContractInfoLoading:I,isSponsored:L,symbol:z,balance:B,onClick:V,transactionDetails:H,transactionIndex:U,maxIndex:ne,onBack:re,chainName:W,validation:G,hasScanDetails:K,setIsScanDetailsOpen:q,preventMaliciousTransaction:J,setPreventMaliciousTransaction:le,tokensSent:Y,tokensReceived:X,isScanning:Z,isCancellable:he,functionName:ge})=>{let{showTransactionDetails:Q,setShowTransactionDetails:_e,hasMoreDetails:ve,isErc20Ish:ye}=(e=>{let[t,n]=(0,N.useState)(!1),r=!0,i=!1;return(!e||e.isErc20Ish||e.action===`transaction`)&&(r=!1),r&&(i=Object.entries(e||{}).some((([e,t])=>t&&![`action`,`isErc20Ish`,`isNFTIsh`].includes(e)))),{showTransactionDetails:t,setShowTransactionDetails:n,hasMoreDetails:r&&i,isErc20Ish:e?.isErc20Ish}})(H),be=u(),$=ye&&I||M||F||Z;return(0,P.jsxs)(P.Fragment,{children:[(0,P.jsx)(o,{onClose:r,backFn:re}),e&&(0,P.jsx)(fe,{children:e}),(0,P.jsxs)(D,{style:{marginTop:e?`1.5rem`:0},children:[s,(0,P.jsx)(ce,{maxIndex:ne,transactionIndex:U})]}),(0,P.jsx)(E,{children:c}),(0,P.jsxs)(b,{style:{marginTop:`2rem`},children:[(!!Y[0]||$)&&(0,P.jsxs)(x,{children:[X.length>0?(0,P.jsx)(w,{children:`Send`}):(0,P.jsx)(w,{children:a===`approve`?`Approval amount`:`Amount`}),(0,P.jsx)(`div`,{className:`flex flex-col`,children:Y.map(((e,t)=>(0,P.jsx)(ae,{iconUrl:e.iconUrl,value:ge===`setApprovalForAll`?`All`:e.value,usdValue:e.usdValue,symbol:e.symbol,nftName:e.nftName,nftCount:e.nftCount,decimals:e.decimals},t)))})]}),X.length>0&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Receive`}),(0,P.jsx)(`div`,{className:`flex flex-col`,children:X.map(((e,t)=>(0,P.jsx)(ae,{iconUrl:e.iconUrl,value:e.value,usdValue:e.usdValue,symbol:e.symbol,nftName:e.nftName,nftCount:e.nftCount,decimals:e.decimals},t)))})]}),H&&`spender`in H&&H?.spender?(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Spender`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:H.spender,url:A?.blockExplorers?.default?.url})})]}):null,l&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`To`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:l,url:A?.blockExplorers?.default?.url,showCopyIcon:!0})})]}),p&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token address`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:p,url:A?.blockExplorers?.default?.url})})]}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Network`}),(0,P.jsx)(S,{children:m})]}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Estimated fee`}),(0,P.jsx)(S,{$isLoading:M||F||L===void 0,children:L?(0,P.jsxs)(pe,{children:[(0,P.jsxs)(me,{children:[`Sponsored by `,be.name]}),(0,P.jsx)(R,{height:16,width:16})]}):_})]}),ve&&!K&&(0,P.jsxs)(P.Fragment,{children:[(0,P.jsx)(x,{className:`cursor-pointer`,onClick:()=>_e(!Q),children:(0,P.jsxs)(C,{className:`flex items-center gap-x-1`,children:[`Details`,` `,(0,P.jsx)(g,{style:{width:`0.75rem`,marginLeft:`0.25rem`,transform:Q?`rotate(180deg)`:void 0}})]})}),Q&&H&&(0,P.jsx)(oe,{action:a,chain:A,transactionDetails:H,isTokenContractInfoLoading:I,symbol:z})]}),K&&(0,P.jsx)(x,{children:(0,P.jsxs)(ie,{onClick:()=>q(!0),children:[(0,P.jsx)(`span`,{className:`text-color-primary`,children:`Details`}),(0,P.jsx)(te,{height:`14px`,width:`14px`,strokeWidth:`2`})]})})]}),(0,P.jsx)(ee,{}),t?(0,P.jsx)(y,{style:{marginTop:`2rem`},children:t.message}):n&&U===0?(0,P.jsx)(y,{style:{marginTop:`2rem`},children:n.shortMessage??de}):null,(0,P.jsx)(se,{variant:G,preventMaliciousTransaction:J,setPreventMaliciousTransaction:le}),(0,P.jsx)(ue,{$useSmallMargins:!(!n&&!t&&G!==`warn`&&G!==`error`),address:v,balance:B,errMsg:M||n||t||!h?void 0:`Add funds on ${A?.name??W} to complete transaction.`}),(0,P.jsx)(i,{style:{marginTop:`1rem`},loading:j,disabled:O||M,onClick:V,children:T}),he&&(0,P.jsx)(f,{style:{marginTop:`1rem`},onClick:r,isSubmitting:!1,children:`Not now`}),(0,P.jsx)(d,{})]})},Y=({img:e,title:t,subtitle:n,cta:r,instructions:a,network:s,blockExplorerUrl:c,isMissingFunds:l,submitError:f,parseError:p,total:h,swap:_,transactingWalletAddress:v,fee:C,balance:T,disabled:O,isSubmitting:j,isPreparing:M,isTokenPriceLoading:F,onClick:I,onClose:te,onBack:L,isSponsored:z})=>{let B=M||F,[V,H]=(0,N.useState)(!1),U=u();return(0,P.jsxs)(P.Fragment,{children:[(0,P.jsx)(o,{onClose:te,backFn:L}),e&&(0,P.jsx)(fe,{children:e}),(0,P.jsx)(D,{style:{marginTop:e?`1.5rem`:0},children:t}),(0,P.jsx)(E,{children:n}),(0,P.jsxs)(b,{style:{marginTop:`2rem`,marginBottom:`.5rem`},children:[(h||B)&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Amount`}),(0,P.jsx)(S,{$isLoading:B,children:h})]}),_&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Swap`}),(0,P.jsx)(S,{children:_})]}),s&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Network`}),(0,P.jsx)(S,{children:s})]}),(C||B||z!==void 0)&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Estimated fee`}),(0,P.jsx)(S,{$isLoading:B,children:z&&!B?(0,P.jsxs)(pe,{children:[(0,P.jsxs)(me,{children:[`Sponsored by `,U.name]}),(0,P.jsx)(R,{height:16,width:16})]}):C})]})]}),(0,P.jsx)(x,{children:(0,P.jsxs)(ie,{onClick:()=>H((e=>!e)),children:[(0,P.jsx)(`span`,{children:`Advanced`}),(0,P.jsx)(g,{height:`16px`,width:`16px`,strokeWidth:`2`,style:{transition:`all 300ms`,transform:V?`rotate(180deg)`:void 0}})]})}),V&&(0,P.jsx)(P.Fragment,{children:a.map(((e,t)=>e.type===`sol-transfer`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsxs)(A,{children:[`Transfer `,e.withSeed?`with seed`:``]})}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Amount`}),(0,P.jsxs)(S,{children:[m({amount:e.value,decimals:e.token.decimals}),` `,e.token.symbol]})]}),!!e.toAccount&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Destination`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.toAccount,url:c})})]})]},t):e.type===`spl-transfer`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsxs)(A,{children:[`Transfer `,e.token.symbol]})}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Amount`}),(0,P.jsx)(S,{children:e.value.toString()})]}),!!e.fromAta&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Source`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.fromAta,url:c})})]}),!!e.toAta&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Destination`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.toAta,url:c})})]}),!!e.token.address&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.token.address,url:c})})]})]},t):e.type===`ata-creation`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsx)(A,{children:`Create token account`})}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Program ID`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.program,url:c})})]}),!!e.owner&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Owner`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.owner,url:c})})]})]},t):e.type===`create-account`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsxs)(A,{children:[`Create account `,e.withSeed?`with seed`:``]})}),!!e.account&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Account`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.account,url:c})})]}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Amount`}),(0,P.jsxs)(S,{children:[m({amount:e.value,decimals:9}),` SOL`]})]})]},t):e.type===`spl-init-account`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsx)(A,{children:`Initialize token account`})}),!!e.account&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Account`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.account,url:c})})]}),!!e.mint&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Mint`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.mint,url:c})})]}),!!e.owner&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Owner`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.owner,url:c})})]})]},t):e.type===`spl-close-account`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsx)(A,{children:`Close token account`})}),!!e.source&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Source`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.source,url:c})})]}),!!e.destination&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Destination`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.destination,url:c})})]}),!!e.owner&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Owner`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.owner,url:c})})]})]},t):e.type===`spl-sync-native`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsx)(A,{children:`Sync native`})}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Program ID`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.program,url:c})})]})]},t):e.type===`raydium-swap-base-input`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsxs)(A,{children:[`Raydium swap`,` `,e.tokenIn&&e.tokenOut?`${e.tokenIn.symbol} → ${e.tokenOut.symbol}`:``]})}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Amount in`}),(0,P.jsx)(S,{children:e.amountIn.toString()})]}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Minimum amount out`}),(0,P.jsx)(S,{children:e.minimumAmountOut.toString()})]}),e.mintIn&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token in`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.mintIn,url:c})})]}),e.mintOut&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token out`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.mintOut,url:c})})]})]},t):e.type===`raydium-swap-base-output`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsxs)(A,{children:[`Raydium swap`,` `,e.tokenIn&&e.tokenOut?`${e.tokenIn.symbol} → ${e.tokenOut.symbol}`:``]})}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Max amount in`}),(0,P.jsx)(S,{children:e.maxAmountIn.toString()})]}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Amount out`}),(0,P.jsx)(S,{children:e.amountOut.toString()})]}),e.mintIn&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token in`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.mintIn,url:c})})]}),e.mintOut&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token out`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.mintOut,url:c})})]})]},t):e.type===`jupiter-swap-shared-accounts-route`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsxs)(A,{children:[`Jupiter swap`,` `,e.tokenIn&&e.tokenOut?`${e.tokenIn.symbol} → ${e.tokenOut.symbol}`:``]})}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`In amount`}),(0,P.jsx)(S,{children:e.inAmount.toString()})]}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Quoted out amount`}),(0,P.jsx)(S,{children:e.quotedOutAmount.toString()})]}),e.mintIn&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token in`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.mintIn,url:c})})]}),e.mintOut&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token out`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.mintOut,url:c})})]})]},t):e.type===`jupiter-swap-exact-out-route`?(0,P.jsxs)(X,{children:[(0,P.jsx)(x,{children:(0,P.jsxs)(A,{children:[`Jupiter swap`,` `,e.tokenIn&&e.tokenOut?`${e.tokenIn.symbol} → ${e.tokenOut.symbol}`:``]})}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Quoted in amount`}),(0,P.jsx)(S,{children:e.quotedInAmount.toString()})]}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Amount out`}),(0,P.jsx)(S,{children:e.outAmount.toString()})]}),e.mintIn&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token in`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.mintIn,url:c})})]}),e.mintOut&&(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Token out`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.mintOut,url:c})})]})]},t):(0,P.jsxs)(X,{children:[(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Program ID`}),(0,P.jsx)(S,{children:(0,P.jsx)(k,{address:e.program,url:c})})]}),(0,P.jsxs)(x,{children:[(0,P.jsx)(w,{children:`Data`}),(0,P.jsx)(S,{children:e.discriminator})]})]},t)))}),(0,P.jsx)(ee,{}),f?(0,P.jsx)(y,{style:{marginTop:`2rem`},children:f.message}):p?(0,P.jsx)(y,{style:{marginTop:`2rem`},children:de}):null,(0,P.jsx)(ue,{$useSmallMargins:!(!p&&!f),title:``,address:v,balance:T,errMsg:M||p||f||!l?void 0:`Add funds on Solana to complete transaction.`}),(0,P.jsx)(i,{style:{marginTop:`1rem`},loading:j,disabled:O||M,onClick:I,children:r}),(0,P.jsx)(d,{})]})},ue=a(j)`
  ${e=>e.$useSmallMargins?`margin-top: 0.5rem;`:`margin-top: 2rem;`}
`,X=a(b)`
  margin-top: 0.5rem;
  border: 1px solid var(--privy-color-foreground-4);
  border-radius: var(--privy-border-radius-sm);
  padding: 0.5rem;
`,de=`There was an error preparing your transaction. Your transaction request will likely fail.`,fe=a.div`
  display: flex;
  width: 100%;
  justify-content: center;
  max-height: 40px;

  > img {
    object-fit: contain;
    border-radius: var(--privy-border-radius-sm);
  }
`,pe=a.span`
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
`,me=a.span`
  font-size: 14px;
  font-weight: 500;
  color: var(--privy-color-foreground);
`,Z=e=>e?.code===F.COMPLIANCE_BLOCKED,he=()=>(0,P.jsxs)(ye,{children:[(0,P.jsx)($,{}),(0,P.jsx)(be,{})]}),ge=({transactionError:e,chainId:t,onClose:n,onRetry:r,chainType:i,transactionHash:a})=>{let{chains:s}=p(),[c,u]=(0,N.useState)(!1),{errorCode:d,errorMessage:f}=((e,t)=>{if(t===`ethereum`)return Z(e)?{errorCode:`Transaction blocked`,errorMessage:e.message}:{errorCode:e.details??e.message,errorMessage:e.shortMessage};let n=e.txSignature,r=e?.transactionMessage||`Something went wrong.`;if(Array.isArray(e.logs)){let t=e.logs.find((e=>/insufficient (lamports|funds)/gi.test(e)));t&&(r=t)}return{transactionHash:n,errorMessage:r}})(e,i),m=Z(e),h=(({chains:e,chainId:t,chainType:n,transactionHash:r})=>n===`ethereum`?e.find((e=>e.id===t))?.blockExplorers?.default.url??`https://etherscan.io`:function(e,t){return`https://explorer.solana.com/tx/${e}?chain=${t}`}(r||``,t))({chains:s,chainId:t,chainType:i,transactionHash:a});return(0,P.jsxs)(P.Fragment,{children:[(0,P.jsx)(o,{onClose:n}),(0,P.jsxs)(Q,{children:[(0,P.jsx)(he,{}),(0,P.jsx)(_e,{children:d}),(0,P.jsx)(ve,{children:m?`This transaction cannot be completed.`:`Please try again.`}),(0,P.jsxs)(Ce,{children:[(0,P.jsx)(Se,{children:`Error message`}),(0,P.jsx)(Te,{$clickable:!1,children:f})]}),a&&(0,P.jsxs)(Ce,{children:[(0,P.jsx)(Se,{children:`Transaction hash`}),(0,P.jsxs)(we,{children:[`Copy this hash to view details about the transaction on a`,` `,(0,P.jsx)(`u`,{children:(0,P.jsx)(`a`,{href:h,children:`block explorer`})}),`.`]}),(0,P.jsxs)(Te,{$clickable:!0,onClick:async()=>{await navigator.clipboard.writeText(a),u(!0)},children:[a,(0,P.jsx)(Oe,{clicked:c})]})]}),!m&&(0,P.jsx)(xe,{onClick:()=>r({resetNonce:!!a}),children:`Retry transaction`})]}),(0,P.jsx)(l,{})]})},Q=a.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
`,_e=a.span`
  color: var(--privy-color-foreground);
  text-align: center;
  font-size: 1.125rem;
  font-weight: 500;
  line-height: 1.25rem; /* 111.111% */
  text-align: center;
  margin: 10px;
`,ve=a.span`
  margin-top: 4px;
  margin-bottom: 10px;
  color: var(--privy-color-foreground-3);
  text-align: center;

  font-size: 0.875rem;
  font-style: normal;
  font-weight: 400;
  line-height: 20px; /* 142.857% */
  letter-spacing: -0.008px;
`,ye=a.div`
  position: relative;
  width: 60px;
  height: 60px;
  margin: 10px;
  display: flex;
  justify-content: center;
  align-items: center;
`,be=a(H)`
  position: absolute;
  width: 35px;
  height: 35px;
  color: var(--privy-color-error);
`,$=a.div`
  position: absolute;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background-color: var(--privy-color-error);
  opacity: 0.1;
`,xe=a(i)`
  && {
    margin-top: 24px;
  }
  transition:
    color 350ms ease,
    background-color 350ms ease;
`,Se=a.span`
  width: 100%;
  text-align: left;
  font-size: 0.825rem;
  color: var(--privy-color-foreground);
  padding: 4px;
`,Ce=a.div`
  width: 100%;
  margin: 5px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
`,we=a.text`
  position: relative;
  width: 100%;
  padding: 5px;
  font-size: 0.8rem;
  color: var(--privy-color-foreground-3);
  text-align: left;
  word-wrap: break-word;
`,Te=a.span`
  position: relative;
  width: 100%;
  background-color: var(--privy-color-background-2);
  padding: 8px 12px;
  border-radius: 10px;
  margin-top: 5px;
  font-size: 14px;
  color: var(--privy-color-foreground-3);
  text-align: left;
  word-wrap: break-word;
  ${e=>e.$clickable&&`cursor: pointer;
  transition: background-color 0.3s;
  padding-right: 45px;

  &:hover {
    background-color: var(--privy-color-foreground-4);
  }`}
`,Ee=a(B)`
  position: absolute;
  top: 13px;
  right: 13px;
  width: 24px;
  height: 24px;
`,De=a(_)`
  position: absolute;
  top: 13px;
  right: 13px;
  width: 24px;
  height: 24px;
`,Oe=({clicked:e})=>(0,P.jsx)(e?De:Ee,{});export{le as n,ge as r,Y as t};