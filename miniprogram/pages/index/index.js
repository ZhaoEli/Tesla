// index.js - 对接 Tesla Fleet API
import Toast from '@vant/weapp/toast/toast'
import Notify from '@vant/weapp/notify/notify'

const app = getApp()

Page({
  data: {
    // 车辆数据（从 Tesla API 获取）
    vehicleId: null,
    vin: '',
    modelName: 'Model 3',
    batteryLevel: 78,
    rangeKm: 500,
    locationText: '获取中...',
    isOnline: false,
    odometerKm: 0,

    // 充电状态
    chargingState: 'Disconnected', // Charging / Disconnected / Complete
    chargeLimit: 100,
    minutesToFullCharge: 0,
    chargerPower: 0,

    // 空调/温度
    climateOn: false,
    insideTemp: null,
    outsideTemp: null,

    // 控制状态
    locked: true,
    sentryOn: false,
    windowsOpen: false,
    chargePortOpen: false,

    // 数据更新时间
    dataUpdateTime: '',

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

    // Tesla OAuth tab 切换
    oauthTab: 'web',
    teslaEmailInput: '',
    teslaPassword: '',
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
                // 保存 userInfo 到 globalData 和 Storage，避免刷新后重复弹窗
                const userData = { openid }
                wx.setStorageSync('userInfo', userData)
                app.globalData.userInfo = userData

                Notify({ type: 'success', message: '微信授权成功' })
                this.setData({ isLoggedIn: true })
                this.checkTeslaBindStatus()
              } else {
                // 降级
                app.globalData.isLoggedIn = true
                const userData = { openid: wx.getStorageSync('openid') || '' }
                wx.setStorageSync('userInfo', userData)
                app.globalData.userInfo = userData
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
        } else {
          // 账号已绑定但是没有车辆 -> 用 mock 数据展示
          this.setMockData()
        }
      } else if (listRes.result && listRes.result.needAuth) {
        // Token 过期或未绑定，保持绑定状态但显示 mock 数据
        this.setData({ isTeslaBound: true })
        this.setMockData()
      } else {
        // getVehicleList 返回了其他错误（如412），但绑定状态还在 -> 用 mock 数据占位
        console.warn('[refreshVehicleData] 获取车辆列表失败，使用Mock数据:', listRes.result)
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
        const cs = v.charge_state || {}
        const vs = v.vehicle_state || {}
        const cls = v.climate_state || {}
        const ds = v.drive_state || {}

        // 计算续航（Tesla API 返回的是 mile，转为 km）
        const batteryRangeMi = cs.battery_range || 0
        const rangeKm = batteryRangeMi > 0 ? Math.round(batteryRangeMi * 1.609) : 0

        // 充电状态
        const chargingState = cs.charging_state || 'Disconnected' // Charging/Disconnected/Complete
        const chargeLimit = cs.charge_limit_soc || 100
        const chargerPower = cs.charger_power || 0
        const minutesToFullCharge = cs.minutes_to_full_charge || 0

        // 车内温度
        const insideTemp = cls.inside_temp != null ? Math.round(cls.inside_temp) : null
        const outsideTemp = cls.outside_temp != null ? Math.round(cls.outside_temp) : null

        // 里程数
        const odometerMi = vs.odometer || 0
        const odometerKm = odometerMi > 0 ? Math.round(odometerMi * 1.609) : 0

        // 位置
        let locationText = this.data.locationText
        if (ds.latitude && ds.longitude) {
          locationText = `${ds.latitude.toFixed(4)}, ${ds.longitude.toFixed(4)}`
        } else if (ds.latitude == null && ds.longitude == null) {
          // 没有位置数据，保留上次
        }

        const now = new Date()
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`

        this.setData({
          vehicleId: v.id || v.id_s || vehicleId,
          modelName: v.display_name || this.data.modelName,
          vin: v.vin || '',
          batteryLevel: cs.battery_level ?? 78,
          rangeKm,
          chargingState,
          chargeLimit,
          minutesToFullCharge,
          chargerPower,
          locked: vs.locked ?? true,
          climateOn: cls.is_climate_on ?? false,
          insideTemp,
          outsideTemp,
          sentryOn: vs.sentry_mode ?? false,
          windowsOpen: vs.windows_open ?? false,
          chargePortOpen: cs.charge_port_door_open ?? false,
          isOnline: v.state === 'online',
          odometerKm,
          locationText,
          dataUpdateTime: timeStr
        })
      } else if (res.result && res.result.needAuth) {
        this.setData({ isTeslaBound: false })
        this.setMockData()
      }
    }).catch(() => {
      // 不降级到 mock，保留上次数据
    })
  },

  /**
   * 唤醒车辆
   */
  wakeUpVehicle() {
    if (!this.data.vehicleId) {
      Notify({ type: 'warning', message: '没有车辆可唤醒' })
      return
    }

    // mock 车辆直接模拟唤醒成功
    if (this.data.vehicleId === 'mock') {
      Notify({ type: 'success', message: '车辆已唤醒' })
      this.setData({ isOnline: true })
      this.fetchVehicleData('mock')
      return
    }

    Toast.loading({ message: '正在唤醒车辆...', forbidClick: true, duration: 0 })

    const openid = app.globalData.openid || wx.getStorageSync('openid')
    wx.cloud.callFunction({
      name: 'controlVehicle',
      data: { openid, vehicleId: this.data.vehicleId, command: 'wake_up' }
    }).then(res => {
      wx.hideLoading()
      if (res.result && res.result.code === 0) {
        Notify({ type: 'success', message: '车辆已唤醒' })
        this.setData({ isOnline: true })
        // 唤醒后再拉取一次数据
        setTimeout(() => this.fetchVehicleData(this.data.vehicleId), 2000)
      } else {
        Notify({ type: 'warning', message: res.result?.message || '唤醒失败' })
      }
    }).catch(() => {
      wx.hideLoading()
      Notify({ type: 'danger', message: '网络异常' })
    })
  },

  setMockData() {
    this.setData({
      vehicleId: 'mock',
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
      vin: 'LRW3E7FS0NC123456',
      odometerKm: 15230,
      chargingState: 'Disconnected',
      chargeLimit: 90,
      minutesToFullCharge: 0,
      chargerPower: 0,
      insideTemp: 26,
      outsideTemp: 32,
      dataUpdateTime: '',
    })
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

  // ===== 方案1：邮箱+密码直登 =====
  switchOauthTab(e) {
    this.setData({ oauthTab: e.currentTarget.dataset.tab })
  },

  onTeslaEmailInput(e) {
    this.setData({ teslaEmailInput: e.detail.value })
  },

  onTeslaPasswordInput(e) {
    this.setData({ teslaPassword: e.detail.value })
  },

  onPasswordLogin() {
    const { teslaEmailInput, teslaPassword } = this.data
    if (!teslaEmailInput || !teslaPassword) {
      Notify({ type: 'warning', message: '请输入 Tesla 账号邮箱和密码' })
      return
    }

    Toast.loading({ message: '正在登录 Tesla...', forbidClick: true })

    wx.cloud.callFunction({
      name: 'teslaAuth',
      data: {
        action: 'passwordLogin',
        email: teslaEmailInput,
        password: teslaPassword
      }
    }).then(res => {
      wx.hideLoading()
      if (res.result && res.result.code === 0) {
        const data = res.result.data || {}
        this.setData({
          isTeslaBound: true,
          teslaEmail: data.teslaEmail || teslaEmailInput,
          vehicleCount: data.vehicleCount || 0,
          teslaPassword: ''
        })
        Notify({ type: 'success', message: 'Tesla 账号绑定成功' })
        setTimeout(() => this.refreshVehicleData(), 500)
      } else {
        Notify({ type: 'danger', message: res.result?.message || 'Tesla 登录失败，请检查账号密码' })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('[PasswordLogin] 失败:', err)
      Notify({ type: 'danger', message: '网络异常，请重试' })
    })
  },
})