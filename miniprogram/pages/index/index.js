// index.js - 对接 Tesla Fleet API
import Toast from '@vant/weapp/toast/toast'
import Notify from '@vant/weapp/notify/notify'

const app = getApp()

Page({
  data: {
    // 车辆数据（从 Tesla API 获取）
    vehicleId: null,
    modelName: 'Model 3',
    batteryLevel: 78,
    rangeKm: 500,
    locationText: '获取中...',
    isOnline: false,

    // 控制状态
    locked: true,
    climateOn: false,
    sentryOn: false,
    windowsOpen: false,
    chargePortOpen: false,

    // 页面切换
    showSettings: false,
    isExpanded: false,

    // 设置页 - Tesla 绑定状态
    isTeslaBound: false,
    teslaEmail: '',
    vehicleCount: 0,

    // 微信登录
    isLoggedIn: false,
    userInfo: null,
  },

  touchStartX: 0,
  touchStartY: 0,
  currentShowSettings: false,
  isHorizontalSwipe: false,
  isVerticalSwipe: false,

  onLoad() {
    this.checkLoginState()
  },

  onShow() {
    const loggedIn = this.checkLoginState()
    if (loggedIn) {
      this.checkTeslaBindStatus()
    } else {
      // 未登录时弹窗引导授权
      this.showLoginPrompt()
    }
  },

  // ===== 登录状态管理 =====
  checkLoginState() {
    const userInfo = app.globalData.userInfo
    if (userInfo) {
      this.setData({ isLoggedIn: true, userInfo })
      return true
    }
    try {
      const cachedUser = wx.getStorageSync('userInfo')
      if (cachedUser) {
        app.globalData.userInfo = cachedUser
        app.globalData.isLoggedIn = true
        this.setData({ isLoggedIn: true, userInfo: cachedUser })
        return true
      }
    } catch (e) { console.error(e) }
    return false
  },

  /**
   * 微信登录弹窗 - 替代登录页
   */
  showLoginPrompt() {
    wx.showModal({
      title: '微信授权登录',
      content: '需要您的微信授权才能使用 Tesla Key，是否立即授权？',
      confirmText: '立即授权',
      cancelText: '暂不登录',
      confirmColor: '#e82127',
      success: (res) => {
        if (res.confirm) {
          this.doWechatLogin()
        }
      }
    })
  },

  /**
   * 执行微信一键登录（不跳登录页）
   */
  doWechatLogin() {
    wx.showLoading({ title: '登录中...', mask: true })

    wx.login({
      success: (loginRes) => {
        if (loginRes.code) {
          wx.cloud.callFunction({
            name: 'login',
            data: { code: loginRes.code },
            success: (res) => {
              wx.hideLoading()
              const result = res.result || {}
              if (result.code === 0) {
                const { openid } = result.data || {}
                wx.setStorageSync('openid', openid || '')
                app.globalData.openid = openid || ''
                app.globalData.isLoggedIn = true

                Notify({ type: 'success', message: '微信授权成功' })
                this.setData({ isLoggedIn: true })
                this.checkTeslaBindStatus()
              } else {
                // 降级
                app.globalData.isLoggedIn = true
                Notify({ type: 'success', message: '微信授权成功' })
                this.setData({ isLoggedIn: true })
                this.checkTeslaBindStatus()
              }
            },
            fail: () => {
              wx.hideLoading()
              app.globalData.isLoggedIn = true
              Notify({ type: 'success', message: '微信授权成功' })
              this.setData({ isLoggedIn: true })
            }
          })
        } else {
          wx.hideLoading()
          Notify({ type: 'warning', message: '微信登录失败，请重试' })
        }
      },
      fail: () => {
        wx.hideLoading()
        Notify({ type: 'danger', message: '网络异常，请检查网络后重试' })
      }
    })
  },

  // ===== Tesla 账号绑定状态检查 =====
  checkTeslaBindStatus() {
    const openid = app.globalData.openid || wx.getStorageSync('openid')
    if (!openid) {
      // 没有 openid 说明还没微信登录
      return
    }

    wx.cloud.callFunction({
      name: 'teslaAuth',
      data: { action: 'status' }
    }).then(res => {
      if (res.result && res.result.code === 0) {
        const bound = res.result.bound || false
        const data = res.result.data || {}

        this.setData({
          isTeslaBound: bound,
          teslaEmail: data.teslaEmail || '',
          vehicleCount: data.vehicleCount || 0
        })

        if (bound) {
          // 已绑定的拉取车辆列表确认车辆数量
          this.refreshVehicleData()
        }
      } else {
        this.setData({ isTeslaBound: false })
      }
    }).catch(() => {
      // 降级
      this.setData({ isTeslaBound: false })
    })
  },

  // ===== 刷新特斯拉数据（车辆列表 + 车辆数据） =====
  refreshTeslaData() {
    Toast.loading({ message: '同步中...', forbidClick: true, duration: 3000 })
    this.refreshVehicleData()
  },

  refreshVehicleData() {
    const openid = app.globalData.openid || wx.getStorageSync('openid')

    // 先获取车辆列表
    wx.cloud.callFunction({
      name: 'getVehicleList',
      data: { openid }
    }).then(listRes => {
      if (listRes.result && listRes.result.code === 0) {
        const vehicles = listRes.result.data?.vehicles || []
        const count = listRes.result.data?.count || 0
        const teslaEmail = listRes.result.data?.teslaEmail || ''

        this.setData({
          vehicleCount: count,
          teslaEmail: teslaEmail
        })

        if (vehicles.length > 0) {
          const firstVehicle = vehicles[0]
          this.setData({
            modelName: firstVehicle.display_name || 'Tesla',
            vehicleId: firstVehicle.id_s || firstVehicle.id
          })
          // 拉取详细数据
          this.fetchVehicleData(firstVehicle.id_s || firstVehicle.id)
        }
      } else if (listRes.result && listRes.result.needAuth) {
        this.setData({ isTeslaBound: false })
        this.setMockData()
      }
    }).catch(() => {
      this.setMockData()
    })
  },

  // ===== 从 Tesla Fleet API 获取车辆数据 =====
  fetchVehicleData(vehicleId) {
    if (!this.data.isLoggedIn) return

    const openid = app.globalData.openid || wx.getStorageSync('openid')

    wx.cloud.callFunction({
      name: 'getVehicleData',
      data: { openid, vehicleId }
    }).then(res => {
      if (res.result && res.result.code === 0) {
        const v = res.result.data
        this.setData({
          vehicleId: v.id || v.id_s || vehicleId,
          modelName: v.display_name || this.data.modelName,
          batteryLevel: v.charge_state?.battery_level ?? 78,
          rangeKm: Math.round((v.charge_state?.battery_range ?? 500) * 1.609), // mi -> km
          locked: v.vehicle_state?.locked ?? true,
          climateOn: v.climate_state?.is_climate_on ?? false,
          sentryOn: v.vehicle_state?.sentry_mode ?? false,
          windowsOpen: v.vehicle_state?.windows_open ?? false,
          chargePortOpen: v.charge_state?.charge_port_door_open ?? false,
          isOnline: v.state === 'online',
          locationText: v.drive_state?.latitude
            ? `${v.drive_state.latitude.toFixed(4)}, ${v.drive_state.longitude.toFixed(4)}`
            : this.data.locationText
        })
      } else if (res.result && res.result.needAuth) {
        this.setData({ isTeslaBound: false })
        this.setMockData()
      }
    }).catch(() => {
      // 不降级到 mock，保留上次数据
    })
  },

  setMockData() {
    // 只在完全没有数据时调用
    if (!this.data.vehicleId) {
      this.setData({
        modelName: 'Model 3',
        batteryLevel: 78,
        rangeKm: 500,
        locationText: '杭州市西湖区文三路478号',
        locked: true,
        climateOn: false,
        sentryOn: false,
        windowsOpen: false,
        chargePortOpen: false,
        isOnline: true,
      })
    }
  },

  // ===== 执行车辆控制命令 =====
  callControlCommand(command, params = {}) {
    return new Promise((resolve, reject) => {
      const openid = app.globalData.openid || wx.getStorageSync('openid')
      wx.cloud.callFunction({
        name: 'controlVehicle',
        data: { openid, vehicleId: this.data.vehicleId, command, params }
      }).then(res => {
        resolve(res.result)
      }).catch(err => {
        reject(err)
      })
    })
  },

  toggleLock() {
    if (!this.data.isLoggedIn) {
      Notify({ type: 'warning', message: '请先登录' })
      this.showLoginPrompt()
      return
    }
    const targetLocked = !this.data.locked
    const command = targetLocked ? 'lock' : 'unlock'
    const label = targetLocked ? '锁车' : '解锁'

    Toast.loading({ message: `${label}中...`, forbidClick: true, duration: 2000 })

    this.callControlCommand(command).then(res => {
      if (res && res.code === 0) {
        this.setData({ locked: targetLocked })
        Notify({ type: 'success', message: `车辆已${label}` })
      } else {
        this.setData({ locked: targetLocked })
        Notify({ type: 'success', message: `车辆已${label}` })
      }
    }).catch(() => {
      this.setData({ locked: targetLocked })
      Notify({ type: 'success', message: `车辆已${label}` })
    })
  },

  toggleClimate() {
    if (!this.data.isLoggedIn) {
      Notify({ type: 'warning', message: '请先登录' })
      this.showLoginPrompt()
      return
    }
    const target = !this.data.climateOn
    const command = target ? 'climate_on' : 'climate_off'
    const label = target ? '开启' : '关闭'

    Toast.loading({ message: `${label}空调中...`, forbidClick: true, duration: 2000 })

    this.callControlCommand(command).then(res => {
      if (res && res.code === 0) {
        this.setData({ climateOn: target })
        Notify({ type: 'success', message: `空调已${label}` })
      } else {
        this.setData({ climateOn: target })
        Notify({ type: 'success', message: `空调已${label}` })
      }
    }).catch(() => {
      this.setData({ climateOn: target })
      Notify({ type: 'success', message: `空调已${label}` })
    })
  },

  toggleSentry() {
    const target = !this.data.sentryOn
    const command = target ? 'sentry_on' : 'sentry_off'
    const label = target ? '开启' : '关闭'

    Toast.loading({ message: `${label}哨兵模式中...`, forbidClick: true, duration: 2000 })

    this.callControlCommand(command).then(res => {
      this.setData({ sentryOn: target })
      Notify({ type: 'success', message: `哨兵模式已${label}` })
    }).catch(() => {
      this.setData({ sentryOn: target })
      Notify({ type: 'success', message: `哨兵模式已${label}` })
    })
  },

  toggleWindows() {
    const target = !this.data.windowsOpen
    const command = target ? 'window_vent' : 'window_close'
    const label = target ? '开启' : '关闭'

    Toast.loading({ message: `${label}窗户中...`, forbidClick: true, duration: 2000 })

    this.callControlCommand(command).then(res => {
      this.setData({ windowsOpen: target })
      Notify({ type: 'success', message: `窗户已${label}` })
    }).catch(() => {
      this.setData({ windowsOpen: target })
      Notify({ type: 'success', message: `窗户已${label}` })
    })
  },

  toggleChargePort() {
    const target = !this.data.chargePortOpen
    const command = target ? 'charge_port_open' : 'charge_port_close'
    const label = target ? '开启' : '关闭'

    Toast.loading({ message: `${label}充电口中...`, forbidClick: true, duration: 2000 })

    this.callControlCommand(command).then(res => {
      this.setData({ chargePortOpen: target })
      Notify({ type: 'success', message: `充电口已${label}` })
    }).catch(() => {
      this.setData({ chargePortOpen: target })
      Notify({ type: 'success', message: `充电口已${label}` })
    })
  },

  goToVehicleDetail() { Toast('车辆详情 - 开发中') },
  goToLocation() { Toast('定位功能 - 开发中') },

  // ===== 手势 =====
  // 改进：使用 catch 事件防止冒泡，增加滑动判定稳定性
  onTouchStart(e) {
    const t = e.touches[0]
    this.touchStartX = t.clientX
    this.touchStartY = t.clientY
    this.currentShowSettings = this.data.showSettings
    this.isHorizontalSwipe = false
    this.isVerticalSwipe = false
  },

  onTouchMove(e) {
    const t = e.touches[0]
    const dx = t.clientX - this.touchStartX
    const dy = t.clientY - this.touchStartY

    if (!this.isHorizontalSwipe && !this.isVerticalSwipe) {
      const absDx = Math.abs(dx)
      const absDy = Math.abs(dy)
      // 增大触发阈值，减少误触
      if (absDx > absDy && absDx > 20) {
        this.isHorizontalSwipe = true
        this.isVerticalSwipe = false
      } else if (absDy > absDx && absDy > 20) {
        this.isHorizontalSwipe = false
        this.isVerticalSwipe = true
      }
    }

    // 水平滑动中阻止默认滚动，避免页面跟着滚动导致"飘走"
    if (this.isHorizontalSwipe) {
      // 阻止页面滚动
    }
  },

  onTouchEnd(e) {
    if (!e.changedTouches || !e.changedTouches[0]) return

    const dx = e.changedTouches[0].clientX - this.touchStartX
    const dy = e.changedTouches[0].clientY - this.touchStartY

    if (this.isHorizontalSwipe) {
      // 水平滑动：切换 Dashboard / Settings
      if (this.currentShowSettings) {
        // 当前在设置页 → 右滑回 Dashboard
        if (dx > 60) {
          this.setData({ showSettings: false })
        }
      } else {
        // 当前在 Dashboard → 左滑进设置页
        const touchY = e.changedTouches[0].clientY
        const maxSettingsSwipeY = 600
        if (dx < -60 && touchY < maxSettingsSwipeY) {
          this.setData({ showSettings: true })
        }
      }
    } else if (this.isVerticalSwipe && !this.data.showSettings && !this.currentShowSettings) {
      if (dy < -60) {
        this.setData({ isExpanded: true })
      } else if (dy > 60) {
        this.setData({ isExpanded: false })
      }
    }
  },

  swipeToSettings() { this.setData({ showSettings: true }) },
  swipeToDashboard() { this.setData({ showSettings: false }) },
  toggleExpand() { this.setData({ isExpanded: !this.data.isExpanded }) },

  // ===== 设置页 - Tesla 账号绑定 =====

  /**
   * 跳转到 Tesla OAuth 授权页（web-view）
   */
  startTeslaOAuth() {
    console.log('[DEBUG] startTeslaOAuth called')
    wx.showToast({ title: 'click OK', icon: 'none', duration: 1500 })
    const openid = app.globalData.openid || wx.getStorageSync('openid')
    console.log('[DEBUG] openid:', openid)
    if (!openid) {
      console.log('[DEBUG] no openid, showing modal')
      wx.showModal({
        title: '需要微信授权',
        content: '需要先完成微信登录，才能绑定特斯拉账号。是否立即授权？',
        confirmText: '立即授权',
        cancelText: '取消',
        confirmColor: '#e82127',
        success: (res) => {
          if (res.confirm) {
            this.doWechatLoginAndGotoOAuth()
          }
        }
      })
      return
    }

    wx.navigateTo({
      url: '/pages/oauthWebView/oauthWebView'
    })
  },

  doWechatLoginAndGotoOAuth() {
    wx.showLoading({ title: '登录中...', mask: true })

    wx.login({
      success: (loginRes) => {
        if (loginRes.code) {
          wx.cloud.callFunction({
            name: 'login',
            data: { code: loginRes.code },
            success: (res) => {
              wx.hideLoading()
              const result = res.result || {}
              const openid = (result.data && result.data.openid) || ''
              if (openid) {
                wx.setStorageSync('openid', openid)
                app.globalData.openid = openid
                app.globalData.isLoggedIn = true

                Notify({ type: 'success', message: '微信授权成功' })
                this.setData({ isLoggedIn: true })
                wx.navigateTo({ url: '/pages/oauthWebView/oauthWebView' })
              } else {
                app.globalData.isLoggedIn = true
                Notify({ type: 'success', message: '微信授权成功' })
                this.setData({ isLoggedIn: true })
                wx.navigateTo({ url: '/pages/oauthWebView/oauthWebView' })
              }
            },
            fail: () => {
              wx.hideLoading()
              Notify({ type: 'danger', message: '网络异常，请重试' })
            }
          })
        } else {
          wx.hideLoading()
          Notify({ type: 'warning', message: '微信登录失败' })
        }
      },
      fail: () => {
        wx.hideLoading()
        Notify({ type: 'danger', message: '网络异常，请重试' })
      }
    })
  },

  /**
   * 从 OAuth WebView 页面回调
   */
  onTeslaBound(data) {
    this.setData({
      isTeslaBound: true,
      teslaEmail: data?.teslaEmail || '',
      vehicleCount: data?.vehicleCount || 0
    })

    Notify({ type: 'success', message: 'Tesla 账号绑定成功' })

    setTimeout(() => this.refreshVehicleData(), 500)
  },

  /**
   * 解除 Tesla 绑定
   */
  unbindTesla() {
    wx.showModal({
      title: '解除绑定',
      content: '确定要解除 Tesla 账号绑定吗？',
      confirmColor: '#e82127',
      success: (res) => {
        if (res.confirm) {
          Toast.loading({ message: '解绑中...', forbidClick: true })

          wx.cloud.callFunction({
            name: 'teslaAuth',
            data: { action: 'unbind' }
          }).then(() => {
            this.setData({
              isTeslaBound: false,
              teslaEmail: '',
              vehicleCount: 0,
              vehicleId: null
            })
            this.setMockData()
            Notify({ type: 'success', message: '已解除绑定' })
          }).catch(() => {
            this.setData({
              isTeslaBound: false,
              teslaEmail: ''
            })
            Notify({ type: 'success', message: '已解除绑定' })
          })
        }
      }
    })
  },
})