const api = require('../../utils/api')
const share = require('../../utils/share')

const pad = (n) => String(n).padStart(2, '0')

Page({
  data: {
    loading: true,
    streak: 0,
    totalLearned: 0,
    totalCheckins: 0,
    monthLabel: '',
    cells: [],
    weekdays: ['日', '一', '二', '三', '四', '五', '六']
  },

  onShareAppMessage() {
    const n = this.data.totalLearned || 0
    const title = n > 0 ? `雅词本｜我已累计记住 ${n} 个雅思词` : ''
    return share.toFriend(title ? { title } : undefined)
  },

  async onShow() {
    try {
      const r = await api.stats()
      const set = {}
      ;(r.dates || []).forEach((d) => {
        set[d] = true
      })

      const now = new Date()
      const y = now.getFullYear()
      const m = now.getMonth()
      const firstWeekday = new Date(y, m, 1).getDay()
      const days = new Date(y, m + 1, 0).getDate()
      const todayStr = `${y}-${pad(m + 1)}-${pad(now.getDate())}`

      const cells = []
      for (let i = 0; i < firstWeekday; i++) cells.push({ key: 'e' + i, empty: true })
      for (let d = 1; d <= days; d++) {
        const ds = `${y}-${pad(m + 1)}-${pad(d)}`
        cells.push({ key: ds, day: d, checked: !!set[ds], isToday: ds === todayStr })
      }

      this.setData({
        loading: false,
        streak: r.streak || 0,
        totalLearned: r.totalLearned || 0,
        totalCheckins: r.totalCheckins || 0,
        monthLabel: `${y} 年 ${m + 1} 月`,
        cells
      })
    } catch (e) {
      this.setData({ loading: false })
    }
  }
})
