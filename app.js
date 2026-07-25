function formatDate(date) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekday = weekdays[date.getDay()];
    return `${month}月${day}日 ${weekday}`;
}

function updateDates() {
    const now = new Date();
    const dateStr = formatDate(now);
    const headerDate = document.getElementById('header-date');
    const overviewDate = document.getElementById('overview-date');
    if (headerDate) headerDate.textContent = dateStr;
    if (overviewDate) overviewDate.textContent = dateStr;
}

function switchTab(tabName) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    const targetPage = document.getElementById('page-' + tabName);
    if (targetPage) {
        targetPage.classList.add('active');
    }
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.tab === tabName) {
            item.classList.add('active');
        }
    });
    window.scrollTo(0, 0);
}

document.addEventListener('DOMContentLoaded', function() {
    updateDates();
});
