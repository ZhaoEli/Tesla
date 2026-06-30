// index.js
// 获取应用实例
const app = getApp()

Page({
  data: {
    motto: 'Tesla Key',
    userInfo: {},
    hasUserInfo: false,
    canIUseGetUserProfile: wx.canIUse('getUserProfile'),
    carStatus: '未连接',
    locked: true
  },

  onLoad() {
    if (wx.getUserProfile) {
      this.setData({
        canIUseGetUserProfile: true
      })
    }
  },

  getUserProfile() {
    // 推荐使用 wx.getUserProfile 获取用户信息
    wx.getUserProfile({
      desc: '用于完善会员资料',
      success: (res) => {
        this.setData({
          userInfo: res.userInfo,
          hasUserInfo: true
        })
      }
    })
  },

  // 锁车/解锁
  toggleLock() {
    this.setData({
      locked: !this.data.locked
    })
    wx.showToast({
      title: this.data.locked ? '已锁车' : '已解锁',
      icon: 'success'
    })
  },

  // 车辆状态查询
  checkCarStatus() {
    wx.showLoading({
      title: '查询中...'
    })
    // TODO: 调用云函数获取车辆状态
    setTimeout(() => {
      wx.hideLoading()
      this.setData({
        carStatus: '在线'
      })
      wx.showToast({
        title: '车辆在线',
        icon: 'success'
      })
    }, 1000)
  }
})