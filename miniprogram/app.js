App({
  onLaunch() {
    // 云开发初始化
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'cloudbase-d1gpcr29e89cb8086',
        traceUser: true
      })
    }

    // 检查登录状态，恢复全局数据
    this._restoreLoginState()
  },

  /**
   * 从本地缓存恢复登录状态到全局数据
   */
  _restoreLoginState() {
    try {
      const userInfo = wx.getStorageSync('userInfo')
      const openid = wx.getStorageSync('openid')
      const token = wx.getStorageSync('token')

      if (userInfo) {
        this.globalData.userInfo = userInfo
        this.globalData.openid = openid || ''
        this.globalData.token = token || ''
        this.globalData.isLoggedIn = true
        console.log('[App] 已恢复登录状态, openid:', openid)
      }
    } catch (e) {
      console.error('[App] 恢复登录状态失败:', e)
    }
  },

  /**
   * 检查是否已登录，未登录时弹窗引导微信登录
   */
  checkLogin() {
    if (!this.globalData.isLoggedIn) {
      // 返回 false，由调用方决定是否弹窗
      return false
    }
    return true
  },

  /**
   * 微信一键登录（不需要跳登录页，直接调用）
   * 成功后会设置 globalData 并返回 true
   */
  wechatLogin(callback) {
    wx.login({
      success: (loginRes) => {
        if (loginRes.code) {
          // 调用云函数 login
          wx.cloud.callFunction({
            name: 'login',
            data: { code: loginRes.code },
            success: (res) => {
              const result = res.result || {}
              if (result.code === 0) {
                const { openid, token } = result.data || {}
                wx.setStorageSync('openid', openid || '')
                wx.setStorageSync('token', token || '')
                this.globalData.openid = openid || ''
                this.globalData.token = token || ''
                this.globalData.isLoggedIn = true
                if (callback) callback(null, result)
              } else {
                // 降级：即使云函数失败也继续
                this.globalData.isLoggedIn = true
                if (callback) callback(null, { code: 0 })
              }
            },
            fail: () => {
              // 云函数调不通，降级为本地登录
              this.globalData.isLoggedIn = true
              if (callback) callback(null, { code: 0 })
            }
          })
        } else {
          if (callback) callback(new Error('登录失败'))
        }
      },
      fail: (err) => {
        if (callback) callback(err)
      }
    })
  },

  globalData: {
    userInfo: null,
    openid: '',
    token: '',
    isLoggedIn: false
  }
})