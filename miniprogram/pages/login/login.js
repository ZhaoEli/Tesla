// login.js
import Toast from '@vant/weapp/toast/toast'
import Notify from '@vant/weapp/notify/notify'

const app = getApp()

Page({
  data: {
    isLoggedIn: false,
    userInfo: null,
    canIUseGetUserProfile: false,
    loading: false,
    // 协议相关
    agreedPrivacy: false,
    showPrivacyPopup: false,
    privacyContent: ''
  },

  onLoad() {
    if (wx.getUserProfile) {
      this.setData({ canIUseGetUserProfile: true })
    }
    this.checkLoginStatus()
  },

  /**
   * 检查本地缓存的登录状态
   */
  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo')
    const token = wx.getStorageSync('token')
    if (userInfo && token) {
      this.setData({ isLoggedIn: true, userInfo })
      // 已登录，直接跳转首页
      this.navigateToIndex()
    }
  },

  /**
   * 隐私协议勾选
   */
  onPrivacyChange(e) {
    this.setData({ agreedPrivacy: e.detail })
  },

  onShowPrivacy() {
    this.setData({
      showPrivacyPopup: true,
      privacyContent: '我们将遵循微信平台隐私保护指引，对你的个人信息进行保护。\n\n1. 我们仅收集你的微信昵称和头像用于展示\n2. 你的登录凭证仅存储在本地\n3. 我们不会向第三方共享你的个人信息\n4. 你可以随时在设置中清除登录信息'
    })
  },

  onClosePrivacy() {
    this.setData({ showPrivacyPopup: false })
  },

  /**
   * 微信授权登录主流程
   * 1. wx.login 获取 code
   * 2. wx.getUserProfile 获取用户信息
   * 3. 调用云函数 login 完成登录鉴权并写入数据库
   */
  onWechatLogin() {
    if (!this.data.agreedPrivacy) {
      Notify({ type: 'warning', message: '请先阅读并同意隐私协议' })
      return
    }

    this.setData({ loading: true })

    wx.login({
      success: (loginRes) => {
        if (loginRes.code) {
          console.log('[Login] wx.login success, code:', loginRes.code)
          this.getUserProfile(loginRes.code)
        } else {
          console.error('[Login] wx.login failed:', loginRes.errMsg)
          Notify({ type: 'danger', message: '微信登录失败，请重试' })
          this.setData({ loading: false })
        }
      },
      fail: (err) => {
        console.error('[Login] wx.login error:', err)
        Notify({ type: 'danger', message: '网络异常，请重试' })
        this.setData({ loading: false })
      }
    })
  },

  /**
   * 获取用户信息（头像、昵称）
   */
  getUserProfile(code) {
    wx.getUserProfile({
      desc: '用于完善会员资料',
      success: (profileRes) => {
        console.log('[Login] getUserProfile success')
        const userInfo = profileRes.userInfo
        this.setData({ userInfo })
        // 调用云函数完成登录
        this.cloudLogin(code, userInfo)
      },
      fail: (err) => {
        console.warn('[Login] getUserProfile cancelled or failed:', err)
        this.setData({ loading: false })
        if (err.errMsg.includes('cancel')) {
          Notify({ type: 'warning', message: '你取消了授权' })
        } else {
          Notify({ type: 'danger', message: '获取用户信息失败' })
        }
      }
    })
  },

  /**
   * 调用云函数完成登录鉴权
   * 将 code 和用户信息传给云函数，由云端完成登录并写入数据库
   */
  cloudLogin(code, userInfo) {
    wx.cloud.callFunction({
      name: 'login',
      data: {
        code,
        userInfo
      },
      success: (res) => {
        console.log('[Login] 云函数调用成功:', res.result)
        const result = res.result || {}

        if (result.code === 0) {
          const { openid, token } = result.data || {}

          // 存储登录信息到本地
          wx.setStorageSync('userInfo', userInfo)
          wx.setStorageSync('openid', openid || '')
          wx.setStorageSync('token', token || '')

          // 更新全局数据
          app.globalData.userInfo = userInfo
          app.globalData.openid = openid || ''
          app.globalData.token = token || ''
          app.globalData.isLoggedIn = true

          this.setData({
            isLoggedIn: true,
            loading: false
          })

          Toast.success('登录成功')

          // 延迟跳转，让用户看到成功提示
          setTimeout(() => {
            this.navigateToIndex()
          }, 1000)
        } else {
          Notify({ type: 'danger', message: result.message || '登录失败' })
          this.setData({ loading: false })
        }
      },
      fail: (err) => {
        console.error('[Login] 云函数调用失败:', err)
        // 云函数调用失败时，走本地登录降级
        Notify({ type: 'warning', message: '云端登录失败，使用本地模式' })

        wx.setStorageSync('userInfo', userInfo)
        app.globalData.userInfo = userInfo
        app.globalData.isLoggedIn = true

        this.setData({
          isLoggedIn: true,
          loading: false
        })

        Toast.success('本地登录成功')
        setTimeout(() => {
          this.navigateToIndex()
        }, 1000)
      }
    })
  },

  /**
   * 跳转到首页
   */
  navigateToIndex() {
    wx.switchTab({
      url: '/pages/index/index',
      fail: () => {
        wx.redirectTo({
          url: '/pages/index/index'
        })
      }
    })
  },

  /**
   * 退出登录
   */
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出登录吗？',
      confirmColor: '#e82127',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('userInfo')
          wx.removeStorageSync('token')
          wx.removeStorageSync('openid')
          app.globalData.userInfo = null
          app.globalData.openid = ''
          app.globalData.token = ''
          app.globalData.isLoggedIn = false

          this.setData({
            isLoggedIn: false,
            userInfo: null
          })

          Notify({ type: 'success', message: '已退出登录' })

          // 退出后跳回登录页
          wx.redirectTo({ url: '/pages/login/login' })
        }
      }
    })
  }
})