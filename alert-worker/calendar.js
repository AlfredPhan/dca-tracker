// Lịch tin kinh tế Mỹ cho bot: nhắc trước 30 phút và liệt kê tin trong ngày ở tin nhắn 8:00 sáng.
// Dữ liệu: data/calendar.json trên website (GitHub Actions tạo mỗi giờ), bot tải lại mỗi giờ và giữ trong bộ nhớ.

const REMIND_MIN = 30;
const ICON = { cpi: '🔥', jobs: '👷', fed: '🏦', speech: '🎤', gdp: '📊', other: '📌' };
const vnHm = (t) => new Date(t + 7 * 3600e3).toISOString().slice(11, 16);
const vnDm = (t) => { const d = new Date(t + 7 * 3600e3); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

// Tải lịch mỗi giờ (phút thứ 3, sau khi GitHub Actions cập nhật ở phút 17 của giờ trước) hoặc khi chưa có.
async function getCalendar(storage, getJson, url, end) {
  let cal = await storage.get('cal');
  if (!cal || end - cal.at >= 3600e3) {
    try {
      const d = await getJson(url);
      cal = { at: end, events: d.events || [], fomc: d.fomc || [] };
      await storage.put('cal', cal);
    } catch (e) {
      console.log('calendar', e.message);
      if (cal) { cal.at = end - 3000e3; await storage.put('cal', cal); } // thử lại sau ~10 phút
    }
  }
  return cal;
}

// Gộp tin trong feed với kỳ họp FOMC (nếu feed chưa có tin FOMC của ngày đó).
function allEvents(cal) {
  const ev = [...(cal?.events || [])];
  for (const f of cal?.fomc || []) {
    if (!ev.some((e) => e.kind === 'fed' && Math.abs(e.t - f.t) < 3 * 3600e3)) ev.push(f);
  }
  return ev.sort((a, b) => a.t - b.t);
}

const line = (e) => `${ICON[e.kind] || '📌'} <b>${vnHm(e.t)}</b> ${e.vi}` +
  (e.forecast ? ` · dự báo ${e.forecast}` : '') + (e.previous ? ` · trước ${e.previous}` : '') + (e.sep ? ' · kèm dự báo kinh tế' : '');

// Gọi mỗi phút: trả về tin nhắc (nếu có tin bắt đầu sau đúng 30 phút).
export async function calendarReminder({ storage, getJson, url, end }) {
  const cal = await getCalendar(storage, getJson, url, end);
  const from = end + REMIND_MIN * 60e3, to = from + 60e3;
  const soon = allEvents(cal).filter((e) => e.t >= from && e.t < to);
  if (!soon.length) return '';
  return `⏰ <b>${REMIND_MIN} phút nữa có tin Mỹ</b> (ảnh hưởng mạnh tới vàng)\n${soon.map(line).join('\n')}\n` +
    '<i>Giá thường giật mạnh hai chiều, spread giãn rộng. Cân nhắc giảm khối lượng hoặc đứng ngoài quanh giờ tin.</i>';
}

// Dùng cho tin nhắn 8:00: các tin trong 24 giờ tới + kỳ họp Fed kế tiếp.
export async function calendarToday({ storage, getJson, url, end }) {
  const cal = await getCalendar(storage, getJson, url, end);
  if (!cal) return '';
  const ev = allEvents(cal);
  const today = ev.filter((e) => e.t >= end && e.t < end + 864e5);
  const fomc = (cal.fomc || []).find((f) => f.t >= end);
  const days = fomc ? Math.ceil((fomc.t - end) / 864e5) : 0;
  return `📅 <b>Tin Mỹ 24 giờ tới</b>\n` +
    (today.length ? today.map((e) => line(e).replace(`<b>${vnHm(e.t)}</b>`, `<b>${vnHm(e.t)} ${vnDm(e.t)}</b>`)).join('\n') : 'Không có tin mạnh nào.') +
    (fomc ? `\n🏦 Họp Fed kế tiếp: ${vnHm(fomc.t)} ${vnDm(fomc.t)} (còn ${days} ngày)` : '');
}
