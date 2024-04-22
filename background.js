var uploadQueue = new Map();

function encodeURIRFC3986(text) {
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent#encoding_for_rfc3986
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function byte2hex(array) {
  return Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("");
}

function byte2buffer(array) {
  const buffer = new ArrayBuffer(array.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < array.length; i++) {
    view[i] = array[i];
  }
  return buffer;
}

function string2byte(text) {
  return new TextEncoder().encode(text);
}

async function sha256(text) {
  const buffer = await crypto.subtle.digest("SHA-256", string2byte(text));
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256File(file) {
  const buffer = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key, data){
  const k = (typeof key === 'string') ? string2byte(key) : byte2buffer(key);
  const m = (typeof data === 'string') ? string2byte(data) : byte2buffer(data);
  const c = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' },true, ['sign']);
  const s = await crypto.subtle.sign('HMAC', c, m);
  return Array.from(new Uint8Array(s))
}

async function signAwsV4(fields) {
  const { method, path, queryString, host, region, payloadHash, accessKey, secretKey } = fields;
  const awsDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const credential = `${awsDate.slice(0, 8)}/${region}/s3/aws4_request`;

  const signingRequest = [
    method.toUpperCase(),
    path,
    queryString,
    "host:" + host,
    "x-amz-date:" + awsDate,
    "",
    "host;x-amz-date",
    payloadHash,
  ].join("\n");
  const signedRequest = await sha256(signingRequest);

  const signingString = [
    "AWS4-HMAC-SHA256",
    awsDate,
    credential,
    signedRequest,
  ].join("\n");
  
  const kDate = await hmacSha256("AWS4" + secretKey, awsDate.slice(0, 8));
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, "s3");
  const kSigning = await hmacSha256(kService, "aws4_request");
  const kSignature = await hmacSha256(kSigning, signingString);
  const signature = byte2hex(kSignature);

  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${credential}, SignedHeaders=host;x-amz-date, Signature=${signature}`;
}

async function getAccount(accountId) {
  const accountInfo = await browser.storage.local.get(accountId);
  if (!accountInfo[accountId] || !("endpoint" in accountInfo[accountId])) {
    throw new Error("ERR_ACCOUNT_NOT_FOUND");
  }
  return accountInfo[accountId];
}

function getAccountEndpoint(account) {
  return `${account.bucket}.${account.endpoint}`
}

function getAccountPrefix(account) {
  let prefix = account.prefix;
  if (prefix.endsWith("/")) { prefix = prefix.slice(0, -1); }
  if (prefix.startsWith("/")) { prefix = prefix.slice(1); }
  return prefix;
}

async function uploadFile(account, upload, data) {
  const name = upload.name;
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const fileSha256  = await sha256File(data);
  const filePath = `${getAccountPrefix(account)}/${date}-SHA256-${fileSha256}/${encodeURIRFC3986(name)}`;
  const sign = await signAwsV4({
    method: "PUT",
    path: `/${filePath}`,
    queryString: "",
    host: getAccountEndpoint(account),
    region: account.region,
    accessKey: account.access_key,
    secretKey: account.secret_key,
    payloadHash: fileSha256,
  });

  const url = `https://${getAccountEndpoint(account)}/${filePath}`;
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Amz-Date": date,
        "X-Amz-Content-SHA256": fileSha256,
        "Authorization": sign,
      },
      body: data,
      signal: upload.abortController.signal,
    });
    delete upload.abortController;
    return { response, url };
  } catch (e) {
    throw new Error("ERR_UPLOAD_FAILED_NETWORK_ERROR");
  }
}

browser.cloudFile.onFileUpload.addListener(async (account, { id, name, data }) => {
  const accountInfo = await getAccount(account.id);
  const upload = { id, name, abortController: new AbortController() };
  uploadQueue.set(id, upload);

  const { response, url } = await uploadFile(accountInfo, upload, data);
  if (response.status == 200) {
    console.log("upload success:", await response.text());
    return { url };
  }

  if (response.status) {
    console.log(await response.text());
    throw new Error(`ERR_UPLOAD_FAILED_HTTP_${response.status}`);
  }

  throw new Error("ERR_UPLOAD_FAILED_UNKNOWN");
});

browser.cloudFile.onFileUploadAbort.addListener((_account, id) => {
  const upload = uploadQueue.get(id);
  if (upload && upload.abortController) { upload.abortController.abort() };
});

browser.cloudFile.getAllAccounts().then(async (accounts) => {
  const allAccounts = await browser.storage.local.get();
  for (let account of accounts) {
    await browser.cloudFile.updateAccount(account.id, {
      configured: account.id in allAccounts,
    });
  }
});

browser.cloudFile.onAccountDeleted.addListener((accountId) => {
  browser.storage.local.remove(accountId);
});