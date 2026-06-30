// logs.js
const util = require('../../utils/util.js')
import Notify from '@vant/weapp/notify/notify'

Page({
  data: {
    logs: []
  },

  onLoad() {
    this.loadLogs()
  },

  loadLogs() {
    const logs = (wx.getStorageSync('logs') || []).map(log => {
      return {
        date: util.formatTime(new Date(log)),
        timeStamp: log
      }
    })
    this.setData({ logs })
  },

  onClearLogs() {
    wx.showModal({
      title: '确认清除',
      content: '确定要清除所有操作日志吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('logs')
          this.setData({ logs: [] })
          Notify({ type: 'success', message: '日志已清除' })
        }
      }
    })
  }
})