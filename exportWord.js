function exportWord() {
  const content = outputBox.textContent;
  const email = document.getElementById('email').value.trim();

  fetch('/export-docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, content })
  })
    .then(res => {
      if (!res.ok) throw new Error('Failed to export Word');
      return res.blob();
    })
    .then(blob => {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'SmartEmail_Response.docx';
      a.click();
      window.URL.revokeObjectURL(url);
      logWindow.style.display = 'block';
      logWindow.textContent += '\nDownloaded .docx file';
    })
    .catch(err => {
      alert('Error: ' + err.message);
    });
}
