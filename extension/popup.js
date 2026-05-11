// 检查后端 + 显示状态
const BACKEND = 'http://localhost:5000/api/health';

document.getElementById('status').textContent = '运行中';

fetch(BACKEND)
  .then((r) => r.json())
  .then((j) => {
    document.getElementById('backend').textContent = '在线 ✓';
    document.getElementById('backend').className = 'ok';
    document.getElementById('count').textContent = j.count || 0;
  })
  .catch(() => {
    document.getElementById('backend').textContent = '离线（启动 backend/server.py）';
    document.getElementById('backend').className = 'fail';
  });
