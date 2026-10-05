// Email templates. Each returns { subject, html, text } for an order notification.
const { settings, formatDate } = require('./config');
const { formatCode } = require('./qr');

// The QR image is attached to the email (Content-ID) when it is sent — see notifications.js.
// Email clients like Gmail and Outlook block images embedded as data: URLs.
const QR_CID = 'pickup-qr';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function firstName(name) {
  return String(name ?? '').split(' ')[0] || 'there';
}

function collectionLines(day) {
  if (!day) return null;
  return {
    when: `${formatDate(day.date)}, ${day.start_time}–${day.end_time}`,
    where: day.location,
    notes: day.notes,
  };
}

function itemsText(order) {
  return order.items.map((i) => `  - ${i.quantity} x ${i.product_name} (${i.unit_price * i.quantity} tokens)`).join('\n');
}

function itemsHtml(order) {
  const rows = order.items.map((i) => `
    <tr>
      <td style="padding:6px 0">${i.quantity} × ${esc(i.product_name)}</td>
      <td style="padding:6px 0;text-align:right"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#86bc25;vertical-align:-1px;margin-right:6px"></span>${i.unit_price * i.quantity}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">${rows}
    <tr><td style="padding:8px 0;border-top:1px solid #e3e3e1"><strong>Total</strong></td>
        <td style="padding:8px 0;border-top:1px solid #e3e3e1;text-align:right"><strong><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#86bc25;vertical-align:-1px;margin-right:6px"></span>${order.total} tokens</strong></td></tr>
  </table>`;
}

function collectionBoxHtml(day, heading = 'Collection details') {
  const c = collectionLines(day);
  if (!c) {
    return `<div style="background:#f2f2f2;border-radius:8px;padding:14px 16px;margin:16px 0">
      <strong>Collection date to be confirmed</strong><br>
      We'll email you as soon as the next collection day is scheduled.
    </div>`;
  }
  return `<div style="background:#f1f8e6;border-radius:8px;padding:14px 16px;margin:16px 0;line-height:1.6">
    <strong>${esc(heading)}</strong><br>
    📅 ${esc(c.when)}<br>
    📍 ${esc(c.where)}${c.notes ? `<br>ℹ️ ${esc(c.notes)}` : ''}
  </div>`;
}

function collectionText(day) {
  const c = collectionLines(day);
  if (!c) return 'Collection date: to be confirmed. We will email you once the next collection day is scheduled.';
  return `When:  ${c.when}\nWhere: ${c.where}${c.notes ? `\nNote:  ${c.notes}` : ''}`;
}

function qrHtml(order) {
  if (!order.pickup_code) return '';
  return `<div style="text-align:center;border:1px dashed #c9e3a0;border-radius:8px;padding:16px;margin:16px 0">
    <div style="font-weight:600;margin-bottom:8px">Show this at the collection desk</div>
    <img src="cid:${QR_CID}" width="180" height="180" alt="Pickup QR code for order #${order.id}" style="display:block;margin:0 auto">
    <div style="margin-top:8px;font-size:13px;color:#53565a">Pickup code</div>
    <div style="font-size:22px;font-weight:700;letter-spacing:3px;font-family:Consolas,Menlo,monospace">${esc(formatCode(order.pickup_code))}</div>
  </div>`;
}

function qrText(order) {
  return order.pickup_code ? `\n\nPickup code: ${formatCode(order.pickup_code)} (show the QR code in this email, or say this code, at the collection desk)` : '';
}

function layout({ title, bodyHtml }) {
  const ordersUrl = `${settings.appUrl}/#orders`;
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#000000">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e3e3e1">
    <tr><td style="padding:20px 24px;background:#000000;color:#ffffff;border-radius:12px 12px 0 0;font-size:18px;font-weight:700">${esc(settings.companyName)} Merch Store<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#86bc25;margin-left:3px"></span></td></tr>
    <tr><td style="padding:24px">
      <h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
      ${bodyHtml}
      <p style="margin:24px 0 0"><a href="${esc(ordersUrl)}" style="display:inline-block;background:#046a38;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px">View my orders</a></p>
    </td></tr>
    <tr><td style="padding:16px 24px;border-top:1px solid #e3e3e1;font-size:12px;color:#53565a">
      This is an automated message from the ${esc(settings.companyName)} Merch Store. Questions? Ask Merch Bot in the store or contact the HR / People team.
    </td></tr>
  </table>
</body></html>`;
}

function footerText() {
  return `\n\nView your orders: ${settings.appUrl}/#orders\n\n— ${settings.companyName} Merch Store`;
}

const templates = {
  order_confirmation(order, day) {
    const subject = day
      ? `Order #${order.id} confirmed – collect on ${formatDate(day.date)}`
      : `Order #${order.id} confirmed`;
    const html = layout({
      title: `Thanks for your order, ${firstName(order.user_name)}! 🎉`,
      bodyHtml: `<p>Your order <strong>#${order.id}</strong> has been placed and <strong>${order.total} tokens</strong> have been deducted from your wallet.</p>
        ${itemsHtml(order)}
        ${collectionBoxHtml(day, 'Please collect your items on')}
        ${qrHtml(order)}
        <p style="color:#53565a;font-size:14px">We'll send you a reminder the day before. Changed your mind? You can cancel from My Orders while the order is still pending and your tokens will be refunded.</p>`,
    });
    const text = `Hi ${firstName(order.user_name)},

Your order #${order.id} has been placed and ${order.total} tokens have been deducted from your wallet.

${itemsText(order)}

${collectionText(day)}${qrText(order)}

We'll send you a reminder the day before.${footerText()}`;
    return { subject, html, text };
  },

  collection_reminder(order, day) {
    const subject = `Reminder: collect your order #${order.id} tomorrow`;
    const html = layout({
      title: `Hey ${firstName(order.user_name)}, your merch is waiting! 👋`,
      bodyHtml: `<p>Just a reminder that your order <strong>#${order.id}</strong> is ready for collection <strong>tomorrow</strong>. Come and pick it up at the designated location:</p>
        ${collectionBoxHtml(day, 'Collection')}
        ${qrHtml(order)}
        ${itemsHtml(order)}`,
    });
    const text = `Hi ${firstName(order.user_name)},

Just a reminder: your order #${order.id} is ready for collection TOMORROW. Come and pick it up at the designated location:

${collectionText(day)}${qrText(order)}

${itemsText(order)}${footerText()}`;
    return { subject, html, text };
  },

  collection_updated(order, day) {
    const subject = day
      ? `Order #${order.id}: collection on ${formatDate(day.date)}`
      : `Order #${order.id}: collection date to be confirmed`;
    const html = layout({
      title: 'Your collection details have been updated',
      bodyHtml: `<p>Hi ${esc(firstName(order.user_name))}, the collection details for your order <strong>#${order.id}</strong> have been set or changed.</p>
        ${collectionBoxHtml(day, 'New collection details')}
        ${day ? qrHtml(order) : ''}
        ${itemsHtml(order)}`,
    });
    const text = `Hi ${firstName(order.user_name)},

The collection details for your order #${order.id} have been set or changed.

${collectionText(day)}${day ? qrText(order) : ''}

${itemsText(order)}${footerText()}`;
    return { subject, html, text };
  },

  order_cancelled(order) {
    const subject = `Order #${order.id} cancelled – ${order.total} tokens refunded`;
    const html = layout({
      title: `Order #${order.id} has been cancelled`,
      bodyHtml: `<p>Hi ${esc(firstName(order.user_name))}, your order <strong>#${order.id}</strong> has been cancelled and <strong>${order.total} tokens</strong> have been refunded to your wallet.</p>
        ${itemsHtml(order)}`,
    });
    const text = `Hi ${firstName(order.user_name)},

Your order #${order.id} has been cancelled and ${order.total} tokens have been refunded to your wallet.

${itemsText(order)}${footerText()}`;
    return { subject, html, text };
  },

  test(user) {
    return {
      subject: 'Merch Store test email',
      html: layout({
        title: 'SMTP is working ✅',
        bodyHtml: `<p>Hi ${esc(firstName(user.name))}, this is a test email from the Merch Store admin portal. If you can read this, outgoing email is configured correctly.</p>`,
      }),
      text: `Hi ${firstName(user.name)},\n\nThis is a test email from the Merch Store admin portal. If you can read this, outgoing email is configured correctly.${footerText()}`,
    };
  },
};

module.exports = { templates, QR_CID };
