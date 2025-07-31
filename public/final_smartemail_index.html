
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>SmartEmail</title>
  <style>
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #f4f4f4;
      margin: 0;
      padding: 40px 20px;
      color: #333;
    }
    .container {
      max-width: 800px;
      margin: 32px auto;
      background: #fff;
      padding: 32px;
      border-radius: 12px;
      box-shadow: 0 0 10px rgba(0,0,0,0.1);
    }
    textarea, input[type="email"] {
      width: 100%;
      padding: 12px;
      margin-top: 8px;
      border-radius: 6px;
      border: 1px solid #ccc;
      resize: vertical;
    }
    button {
      padding: 10px 16px;
      margin-top: 16px;
      margin-right: 8px;
      font-size: 16px;
      cursor: pointer;
    }
    .disabled {
      background-color: #ccc;
      cursor: not-allowed;
    }
    .ai-response-container {
      margin-top: 30px;
      background: #eef;
      padding: 16px;
      border-radius: 6px;
    }
    .enhance-controls {
      margin-top: 16px;
    }
    .enhance-controls button {
      margin-right: 8px;
    }
    #tier-log {
      margin-top: 20px;
      text-align: right;
      font-size: 14px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>SmartEmail Generator</h2>
    <input type="email" id="email" placeholder="Enter your email" />
    <textarea id="user-input" rows="6" placeholder="Paste your email content here..."></textarea>
    <br />
    <button onclick="generateResponse()">Generate Reply</button>

    <div class="ai-response-container" id="response-container" style="display:none;">
      <h3>AI Response</h3>
      <div id="ai-response"></div>
      <div class="enhance-controls">
        <button onclick="copyText()">Copy Text</button>
        <button onclick="exportText('pdf')">Export as PDF</button>
        <button onclick="exportText('txt')">Export as TXT</button>
        <button id="enhance-btn" onclick="enhanceReply()">Enhance</button>
      </div>
    </div>

    <div id="tier-log"></div>
  </div>

  <script>
    let userTier = 'free';

    window.onload = () => {
      const storedEmail = localStorage.getItem('smartemail');
      if (storedEmail) {
        document.getElementById('email').value = storedEmail;
        checkTier(storedEmail);
      }
    };

    async function checkTier(email) {
      try {
        const res = await fetch('/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, content: 'license-check' })
        });
        const data = await res.json();
        userTier = data.tier || 'free';
        updateFeatureAccess();
        document.getElementById('tier-log').innerText = 'Tier: ' + userTier;
      } catch (e) {
        console.error('Tier check failed:', e);
      }
    }

    async function generateResponse() {
      const email = document.getElementById('email').value.trim();
      const content = document.getElementById('user-input').value.trim();
      if (!email || !content) return alert('Email and content are required.');

      localStorage.setItem('smartemail', email);

      const res = await fetch('/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, content })
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      userTier = data.tier;
      document.getElementById('ai-response').innerText = data.reply;
      document.getElementById('response-container').style.display = 'block';
      updateFeatureAccess();
      document.getElementById('tier-log').innerText = 'Tier: ' + userTier;
    }

    function updateFeatureAccess() {
      const enhanceBtn = document.getElementById('enhance-btn');
      enhanceBtn.disabled = (userTier === 'free');
      enhanceBtn.classList.toggle('disabled', userTier === 'free');
    }

    async function enhanceReply() {
      if (userTier === 'free') return;

      const email = document.getElementById('email').value.trim();
      const currentReply = document.getElementById('ai-response').innerText;

      const res = await fetch('/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, content: currentReply, action: 'enhance' })
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      document.getElementById('ai-response').innerText = data.reply;
    }

    function copyText() {
      navigator.clipboard.writeText(document.getElementById('ai-response').innerText);
    }

    function exportText(type) {
      const text = document.getElementById('ai-response').innerText;
      const blob = new Blob([text], { type: type === 'pdf' ? 'application/pdf' : 'text/plain' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `SmartEmail.${type}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  </script>
</body>
</html>
