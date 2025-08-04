let userEmail = '';
let userTier = 'free';

// Load email from local storage or show prompt
window.onload = () => {
  const storedEmail = localStorage.getItem('email');
  if (storedEmail) {
    userEmail = storedEmail;
    checkLicense();
  } else {
    document.getElementById('emailPrompt').classList.remove('hidden');
    document.getElementById('licenseStatus').innerText = 'Please enter your email to continue';
  }
};

async function saveEmail() {
  const emailInput = document.getElementById('emailInput').value;
  if (!emailInput) return alert('Please enter your email');

  localStorage.setItem('email', emailInput);
  userEmail = emailInput;
  document.getElementById('emailPrompt').classList.add('hidden');
  checkLicense();
}

async function checkLicense() {
  document.getElementById('licenseStatus').innerText = 'Checking license...';

  try {
    const response = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userEmail, content: 'license-check' })
    });

    const data = await response.json();

    if (data.error) {
      document.getElementById('licenseStatus').innerText = 'License check failed. Limited access.';
    } else {
      userTier = data.tier || 'free';
      document.getElementById('licenseStatus').innerText = `Welcome, your tier is: ${userTier}`;
      document.getElementById('mainApp').classList.remove('hidden');
    }
  } catch (err) {
    console.error(err);
    document.getElementById('licenseStatus').innerText = 'Error during license check.';
  }
}

async function fetchEmails() {
  const email = document.getElementById('imapEmail').value;
  const password = document.getElementById('imapPassword').value;
  const server = document.getElementById('imapServer').value;

  if (!email || !password || !server) {
    return alert('All IMAP fields are required.');
  }

  const prompt = `Summarize the latest emails for: ${email}`;

  try {
    const response = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userEmail, content: prompt })
    });

    const data = await response.json();
    if (data.error) {
      alert(data.error);
    } else {
      const resultContainer = document.getElementById('emailResults');
      resultContainer.innerHTML = `<div class="p-3 bg-gray-100 rounded">${data.reply}</div>`;
    }
  } catch (err) {
    console.error(err);
    alert('Failed to summarize emails.');
  }
}

async function loadLeads() {
  try {
    const response = await fetch('https://YOUR_SUPABASE_URL/rest/v1/leads?select=email,original_message,generated_reply&order=created_at.desc', {
      headers: {
        apikey: 'YOUR_SUPABASE_ANON_KEY',
        Authorization: 'Bearer YOUR_SUPABASE_ANON_KEY'
      }
    });

    const leads = await response.json();
    const list = document.getElementById('leadList');
    list.innerHTML = '';

    leads.forEach((lead) => {
      const item = document.createElement('div');
      item.className = 'p-3 border border-gray-200 rounded bg-white';
      item.innerHTML = `
        <p><strong>Email:</strong> ${lead.email}</p>
        <p><strong>Message:</strong> ${lead.original_message}</p>
        <p><strong>Reply:</strong> ${lead.generated_reply}</p>
      `;
      list.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    alert('Failed to load leads.');
  }
}

async function enhanceText(inputText) {
  if (userTier === 'free') {
    alert('Enhancement is only available for Pro and Premium users.');
    return;
  }

  try {
    const response = await fetch('/enhance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: userEmail,
        input: inputText,
        tier: userTier
      })
    });

    const data = await response.json();
    if (data.error) {
      alert(`Enhance failed: ${data.error}`);
    } else {
      const resultContainer = document.getElementById('emailResults');
      resultContainer.innerHTML += `
        <div class="p-3 mt-3 bg-green-100 rounded">
          <strong>Enhanced:</strong><br>${data.enhanced}
        </div>`;
    }
  } catch (err) {
    console.error(err);
    alert('Network error while enhancing.');
  }
}
