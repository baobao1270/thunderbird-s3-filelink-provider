const form = document.querySelector("form");
const save = form.querySelector("button[name=save]");
const accountId = new URL(location.href).searchParams.get("accountId");
const fields = ["endpoint", "region", "bucket", "prefix", "access_key", "secret_key"];

function getInput(name) {
  return form.querySelector(`input[name="${name}"]`);
}

function setInputValueFromAccountInfo(fieldName, account) {
  if (fieldName in account) {
    getInput(fieldName).value = account[fieldName];
  }
}

function setFormDisableState(disabled) {
  save.disabled = disabled;
  fields.forEach(name => {
    getInput(name).disabled = disabled;
  });
}

(() => {
  for (let element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = browser.i18n.getMessage(element.dataset.i18n);
  }

  browser.storage.local.get(accountId).then(account => {
    if (!account[accountId]) return;
    fields.forEach(fieldName => {
      setInputValueFromAccountInfo(fieldName, account[accountId]);
    });
  });
})();

save.onclick = async () => {
  if (!form.checkValidity()) return;
  setFormDisableState(true);

  let accountInfo = {};
  fields.forEach(name => {
    accountInfo[name] = getInput(name).value;
  });
  
  await browser.storage.local.set({
    [accountId]: accountInfo,
  });

  await browser.cloudFile.updateAccount(accountId, { configured: true });
  setFormDisableState(false);
};
