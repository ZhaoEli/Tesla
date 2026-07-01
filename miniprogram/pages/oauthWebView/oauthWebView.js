// oauthWebView.js - Tesla OAuth 授权页
//
// 流程：
//   1. onLoad: 调用 teslaAuth 云函数获取 OAuth 授权 URL
//   2. 打开 web-view 加载 Tesla 登录页
//   3. 用户登录并授权后，Tesla 重定向到回调页（云开发静态托管）
//   4. 回调页从 URL 提取 code，通过 postMessage 发送给小程序
//   5. 小程序收到 code 后调 teslaAuth exchangeCode 换 token
//   6. 通知上一页更新状态
//
const app = getApp()

Page({
  data: {
    authUrl: '',
    loading: true,
    showError: false,
    errorMsg: '',
    codeReceived: false // 防止重复处理
  },

  onLoad() {
    this.generateAuthUrl()
  },

  /**
   * 生成 Tesla OAuth 授权 URL
   */
  generateAuthUrl() {
    const openid = app.globalData.openid || wx.getStorageSync('openid')

    this.setData({ loading: true, showError: false })

    wx.cloud.callFunction({
      name: 'teslaAuth',
      data: {
        action: 'generateUrl',
        openid
      }
    }).then(res => {
      if (res.result && res.result.code === 0) {
        this.setData({
          authUrl: res.result.data.authUrl,
          loading: false
        })
      } else {
        const detailMsg = res.result?.error || res.result?.message || '获取授权链接失败'
        console.error('[OAuthWebView] 生成URL失败-详情:', detailMsg)
        this.setData({
          loading: false,
          showError: true,
          errorMsg: detailMsg
        })
      }
    }).catch(err => {
      console.error('[OAuthWebView] 生成授权URL失败:', err)
      this.setData({
        loading: false,
        showError: true,
        errorMsg: '网络异常，请检查网络后重试'
      })
    })
  },

  /**
   * web-view 加载完成
   */
  onWebViewLoad(e) {
    this.setData({ loading: false })
  },

  /**
   * web-view 加载失败
   */
  onWebViewError(e) {
    console.error('[OAuthWebView] web-view 加载失败:', e.detail)
    this.setData({
      loading: false,
      showError: true,
      errorMsg: '无法加载 Tesla 授权页面，请检查网络连接'
    })
  },

  /**
   * 接收 web-view 的 postMessage
   * 回调页面 (tesla_callback.html) 在加载完成时发送 code
   */
  onWebViewMessage(e) {
    if (this.data.codeReceived) return // 防止重复处理

    console.log('[OAuthWebView] 收到 web-view 消息:', JSON.stringify(e.detail))

    const messages = e.detail.data || []
    for (const msg of messages) {
      if (msg.type === 'oauth_callback' && msg.code) {
        this.exchangeCode(msg.code)
        break
      }
    }
  },

  /**
   * 用 authorization_code 换取 token
   */
  exchangeCode(code) {
    this.setData({ codeReceived: true })
    const openid = app.globalData.openid || wx.getStorageSync('openid')

    wx.showLoading({ title: '正在绑定...', mask: true })

    wx.cloud.callFunction({
      name: 'teslaAuth',
      data: {
        action: 'exchangeCode',
        openid,
        code
      }
    }).then(res => {
      wx.hideLoading()

      if (res.result && res.result.code === 0) {
        wx.showToast({ title: '绑定成功', icon: 'success', duration: 2000 })

        // 通知上一页（index）刷新绑定状态
        const pages = getCurrentPages()
        const prevPage = pages[pages.length - 2]
        if (prevPage && prevPage.onTeslaBound) {
          prevPage.onTeslaBound(res.result.data)
        }

        // ===== 自动注册 Partner Account（后台静默执行，不阻塞） =====
        wx.cloud.callFunction({
          name: 'teslaAuth',
          data: { action: 'register' }
        }).then(regRes => {
          if (regRes.result && regRes.result.code === 0) {
            console.log('[OAuthWebView] Partner Account 注册成功')
            // 通知 index 页刷新车辆数据
            if (prevPage && prevPage.refreshVehicleData) {
              setTimeout(() => prevPage.refreshVehicleData(), 500)
            }
          } else {
            console.warn('[OAuthWebView] Partner Account 注册失败:', regRes.result?.message)
          }
        }).catch(regErr => {
          console.error('[OAuthWebView] Partner Account 注册异常:', regErr)
        })

        // 返回上一页
        setTimeout(() => {
          wx.navigateBack({ delta: 1 })
        }, 1500)
      } else {
        wx.showModal({
          title: '绑定失败',
          content: res.result?.message || 'Tesla 授权失败，请重试',
          showCancel: false
        })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('[OAuthWebView] exchangeCode 失败:', err)
      wx.showModal({
        title: '网络错误',
        content: '绑定请求失败，请检查网络后重试',
        showCancel: false
      })
    })
  },

  /**
   * 重试
   */
  onRetry() {
    this.setData({ codeReceived: false })
    this.generateAuthUrl()
  },

  /**
   * 关闭页面
   */
  onClose() {
    wx.navigateBack({ delta: 1 })
  }
})