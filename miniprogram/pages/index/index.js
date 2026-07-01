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
    carStatus: 'sleeping', // sleeping(休眠) / waking(唤醒中) / parked(已驻车) / driving(行车中)
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

    // 唤醒轮询
    wakePollCount: 0,
    wakePollTimer: null,
    _pendingCommand: null, // 唤醒成功后待执行的命令 { command, params, label, onSuccess }

    // 数据更新时间
    dataUpdateTime: '',

    // 页面切换
    showSettings: false,
    isExpanded: false,

    // 防重复点击
    isCommandLoading: false,

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

        // 判断车辆状态
        const isOnline = v.state === 'online'
        let carStatus = 'sleeping'
        let locationText = this.data.locationText

        if (isOnline) {
          const hasLocation = ds.latitude != null && ds.longitude != null
          if (hasLocation) {
            carStatus = 'driving'
            locationText = `${ds.latitude.toFixed(4)}, ${ds.longitude.toFixed(4)}`
          } else {
            carStatus = 'parked'
            locationText = '已驻车'
          }
        } else {
          carStatus = 'sleeping'
          locationText = '休眠中'
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
          isOnline,
          carStatus,
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
   * 唤醒车辆（仅休眠状态时使用）
   * 流程：调用 wake_up API → 检查响应 → 轮询等待车辆上线
   */
  wakeUpVehicle() {
    // 防止重复点击
    if (this.data.carStatus === 'waking') {
      return
    }

    // 没有 vehicleId 时先获取车辆列表
    if (!this.data.vehicleId) {
      console.log('[wakeUpVehicle] vehicleId 为空，先获取车辆列表')
      this.refreshVehicleData()
      return
    }

    // mock 车辆直接模拟唤醒成功
    if (this.data.vehicleId === 'mock') {
      Notify({ type: 'success', message: '车辆已唤醒' })
      this.setData({ isOnline: true, carStatus: 'parked', locationText: '已驻车' })
      this.fetchVehicleData('mock')
      // 执行待执行命令
      if (this.data._pendingCommand) {
        const cmd = this.data._pendingCommand
        this.setData({ _pendingCommand: null })
        setTimeout(() => {
          this._executeCommand(cmd.command, cmd.params, cmd.label, cmd.onSuccess)
        }, 500)
      }
      return
    }

    // 进入唤醒中状态，清除之前的轮询
    this._clearWakePoll()
    this.setData({
      carStatus: 'waking',
      locationText: '唤醒中...',
      wakePollCount: 0
    })

    const openid = app.globalData.openid || wx.getStorageSync('openid')
    wx.cloud.callFunction({
      name: 'controlVehicle',
      data: { openid, vehicleId: this.data.vehicleId, command: 'wake_up' }
    }).then(res => {
      console.log('[wakeUpVehicle] controlVehicle 返回:', JSON.stringify(res.result))
      const r = res.result || {}

      if (r.code === -2) {
        // 需要重新授权
        this._onWakeFailed()
        this.showCommandError(r, this.data._pendingCommand ? this.data._pendingCommand.label + '失败' : '唤醒失败')
        return
      }

      if (r.code !== 0) {
        // 接口报错
        this._onWakeFailed()
        this.showCommandError(r, this.data._pendingCommand ? this.data._pendingCommand.label + '失败' : '唤醒失败')
        return
      }

      // wake_up 返回 result: true 说明车辆已在线，直接执行 pending 命令
      if (r.result === true) {
        console.log('[wakeUpVehicle] 车辆已在线，无需轮询')
        this.setData({ carStatus: 'parked', locationText: '已驻车', isOnline: true })
        // 刷新一次数据获取最新状态
        this.fetchVehicleData(this.data.vehicleId)
        // 执行待执行命令
        if (this.data._pendingCommand) {
          const cmd = this.data._pendingCommand
          this.setData({ _pendingCommand: null })
          setTimeout(() => {
            this._executeCommand(cmd.command, cmd.params, cmd.label, cmd.onSuccess)
          }, 500)
        }
        return
      }

      // wake_up 已发送但车辆尚未上线，开始轮询
      this._startWakePoll()
    }).catch(() => {
      // 网络异常，也尝试轮询（可能 API 已发出但响应丢失）
      console.log('[wakeUpVehicle] 网络异常，开始轮询')
      this._startWakePoll()
    })
  },

  /**
   * 确保车辆在线后执行命令（休眠时先唤醒）
   */
  ensureOnlineThen(command, params, label, onSuccess) {
    if (this.data.carStatus === 'waking') return

    // 车辆已在线（已驻车/行车中），直接执行，无需唤醒检查
    if (this.data.carStatus === 'parked' || this.data.carStatus === 'driving') {
      this._executeCommand(command, params, label, onSuccess)
      return
    }

    // 策略：先直接发命令，节约唤醒费用
    // 如果车辆在线，命令直接成功
    // 如果车辆休眠（408），_executeCommand 内部自动触发唤醒后重试
    this._executeCommand(command, params, label, onSuccess)
  },

  /**
   * 实际执行命令
   */
  _executeCommand(command, params, label, onSuccess) {
    this.setData({ isCommandLoading: true })
    Toast.loading({ message: `${label}中...`, forbidClick: true, duration: 0 })

    this.callControlCommand(command, params).then(res => {
      Toast.clear()
      if (res && res.code === 0) {
        if (onSuccess) onSuccess()
        this.setData({ isCommandLoading: false })
        Notify({ type: 'success', message: `${label}成功` })
      } else if (res && res.statusCode === 408) {
        // 车辆不可用（休眠），保存命令，发送 wake_up 信号
        // 防止循环：如果已经在唤醒流程中，直接报错
        if (this.data.carStatus === 'waking') {
          this.showCommandError(res, `${label}失败`)
          return
        }
        this.setData({ isCommandLoading: false })
        console.log('[executeCommand] 车辆休眠(408)，发送唤醒信号后重试')
        this.setData({ _pendingCommand: { command, params, label, onSuccess } })
        this.wakeUpVehicle()
      } else if (res && (res.statusCode === 403 || res.code === -2)) {
        // 403 / token 过期：永久性错误，不重试，不唤醒
        this.setData({ isCommandLoading: false })
        this.showCommandError(res, label + '失败')
      } else {
        this.setData({ isCommandLoading: false })
        this.showCommandError(res, `${label}失败`)
      }
    }).catch(() => {
      Toast.clear()
      this.setData({ isCommandLoading: false })
      this.showCommandError(null, `${label}失败`)
    })
  },

  /**
   * 开始轮询等待车辆上线（使用轻量在线检查代替昂贵的 vehicle_data）
   * 最多 15 次，每次间隔 3 秒，共 45 秒
   */
  _startWakePoll() {
    const INTERVAL = 3000
    const poll = () => {
      const count = this.data.wakePollCount + 1
      this.setData({ wakePollCount: count })
      console.log(`[wakePoll] 第 ${count} 次轻量检查车辆状态...`)
      this._checkVehicleOnline()
    }
    const timer = setTimeout(poll, INTERVAL)
    this.setData({ wakePollTimer: timer })
  },

  /**
   * 轻量检查车辆是否在线（使用 vehicles 列表 API，比 vehicle_data 便宜得多）
   */
  _checkVehicleOnline() {
    const openid = app.globalData.openid || wx.getStorageSync('openid')
    wx.cloud.callFunction({
      name: 'controlVehicle',
      data: { openid, checkOnline: true }
    }).then(res => {
      const r = res.result || {}
      if (r.code === 0 && r.state === 'online') {
        // 车辆已上线，停止轮询
        this._clearWakePoll()
        this.setData({ carStatus: 'parked', locationText: '已驻车', isOnline: true })
        wx.showToast({ title: '车辆已唤醒', icon: 'success', duration: 2000 })
        // 刷新一次完整数据获取最新状态
        this.fetchVehicleData(this.data.vehicleId)
        // 执行待执行命令
        if (this.data._pendingCommand) {
          const cmd = this.data._pendingCommand
          this.setData({ _pendingCommand: null })
          setTimeout(() => {
            this._executeCommand(cmd.command, cmd.params, cmd.label, cmd.onSuccess)
          }, 500)
        }
      } else {
        // 车辆仍未上线，继续轮询
        console.log('[wakePoll] 车辆尚未上线, count:', this.data.wakePollCount)
        this._scheduleNextWakePoll()
      }
    }).catch(() => {
      this._scheduleNextWakePoll()
    })
  },

  /**
   * 唤醒失败/超时，恢复休眠状态
   */
  _onWakeFailed() {
    this._clearWakePoll()
    this.setData({
      carStatus: 'sleeping',
      locationText: '休眠中',
      isOnline: false,
      _pendingCommand: null
    })
  },

  /**
   * 清除轮询定时器
   */
  _clearWakePoll() {
    if (this.data.wakePollTimer) {
      clearTimeout(this.data.wakePollTimer)
      this.setData({ wakePollTimer: null })
    }
  },

  /**
   * 安排下一次轮询（3 秒后）
   */
  _scheduleNextWakePoll() {
    const MAX_POLL = 15
    if (this.data.wakePollCount >= MAX_POLL) {
      console.log('[wakePoll] 轮询超时')
      this._onWakeFailed()
      this.showCommandError(null, this.data._pendingCommand ? this.data._pendingCommand.label + '超时' : '唤醒超时')
      return
    }
    const timer = setTimeout(() => {
      this._checkVehicleOnline()
    }, 3000)
    this.setData({ wakePollTimer: timer })
  },

  /**
   * 点击顶部状态区域 - 仅休眠时可点击唤醒
   */
  onTapStatus() {
    console.log('[onTapStatus] carStatus:', this.data.carStatus)
    if (this.data.carStatus === 'sleeping') {
      this.wakeUpVehicle()
    }
  },

  setMockData() {
    this.setData({
      vehicleId: 'mock',
      carStatus: 'parked',
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

  toggleTrunk() {
    if (!this.data.isLoggedIn) {
      Notify({ type: 'warning', message: '请先登录' })
      this.showLoginPrompt()
      return
    }
    this.ensureOnlineThen('trunk_open', null, '开启后备箱')
  },

  toggleHorn() {
    if (!this.data.isLoggedIn) {
      Notify({ type: 'warning', message: '请先登录' })
      this.showLoginPrompt()
      return
    }
    this.ensureOnlineThen('honk_horn', null, '鸣笛')
  },

  toggleLock() {
    console.log('[toggleLock] 被调用, locked:', this.data.locked, 'isLoggedIn:', this.data.isLoggedIn, 'isCommandLoading:', this.data.isCommandLoading)

    // 防重复点击
    if (this.data.isCommandLoading) {
      console.log('[toggleLock] 命令执行中，忽略重复点击')
      return
    }

    if (!this.data.isLoggedIn) {
      Notify({ type: 'warning', message: '请先登录' })
      this.showLoginPrompt()
      return
    }
    const targetLocked = !this.data.locked
    const command = targetLocked ? 'lock' : 'unlock'
    const label = targetLocked ? '锁车' : '解锁'

    console.log('[toggleLock] 发送命令:', command, 'vehicleId:', this.data.vehicleId)
    this.ensureOnlineThen(command, null, label, () => {
      this.setData({ locked: targetLocked })
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

    this.ensureOnlineThen(command, null, `${label}空调`, () => {
      this.setData({ climateOn: target })
    })
  },

  toggleSentry() {
    const target = !this.data.sentryOn
    const command = target ? 'sentry_on' : 'sentry_off'
    const label = target ? '开启' : '关闭'

    this.ensureOnlineThen(command, null, `${label}哨兵模式`, () => {
      this.setData({ sentryOn: target })
    })
  },

  toggleWindows() {
    const target = !this.data.windowsOpen
    const command = target ? 'window_vent' : 'window_close'
    const label = target ? '开启' : '关闭'

    this.ensureOnlineThen(command, null, `${label}窗户`, () => {
      this.setData({ windowsOpen: target })
    })
  },

  toggleChargePort() {
    const target = !this.data.chargePortOpen
    const command = target ? 'charge_port_open' : 'charge_port_close'
    const label = target ? '开启' : '关闭'

    this.ensureOnlineThen(command, null, `${label}充电口`, () => {
      this.setData({ chargePortOpen: target })
    })
  },

  goToVehicleDetail() { Toast('车辆详情 - 开发中') },
  goToLocation() { Toast('定位功能 - 开发中') },

  /**
   * 统一展示命令执行错误弹窗
   */
 showCommandError(res, title) {
   console.log('[showCommandError]', title, JSON.stringify(res))
   let parts = []
    if (res) {
      const desc = res.responseData?.error_description || ''
      const err = res.responseData?.error || res.error || ''
      if (res.statusCode) parts.push('HTTP ' + res.statusCode)
      if (desc) parts.push(desc)
      else if (err) parts.push(err)
      if (res.message) parts.push(res.message)
    }
    const content = parts.length > 0 ? parts.join('\n') : '网络异常，请检查网络后重试'
    // 同时使用 Modal 弹窗 和 Notify 通知，确保报错可见
    wx.showModal({
      title: title || '请求失败',
      content: content,
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#e82127'
    })
    Notify({ type: 'danger', message: title || '请求失败', duration: 3000 })
  },

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
